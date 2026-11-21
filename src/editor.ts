import { Editor, Node, Mark, Extension, mergeAttributes, textblockTypeInputRule, markInputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  markdownToTiptapJSON,
  tiptapJSONToMarkdown,
  type BibleEntry,
  type OutlineType,
} from './markdown';

// 1. Custom Outline Heading Node ([[part/Home]], [[chapter/Ogden]], etc.)
const OutlineHeading = Node.create({
  name: 'outlineHeading',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      outlineType: {
        default: 'scene' as OutlineType,
        parseHTML: (el) => el.getAttribute('data-outline-type') || 'scene',
        renderHTML: (attrs) => ({ 'data-outline-type': attrs.outlineType }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-outline-type]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'outline-heading' }), 0];
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^\[\[(part|chapter|scene|beat|sub-beat)\/\s?$/i,
        type: this.type,
        getAttributes: (match) => ({ outlineType: match[1].toLowerCase() }),
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Backspace at the very start of an outline heading turns it back into a paragraph
      Backspace: ({ editor }) => {
        const { $anchor, empty } = editor.state.selection;
        if (empty && $anchor.parent.type.name === this.name && $anchor.parentOffset === 0) {
          return editor.commands.setNode('paragraph');
        }
        return false;
      },
      // Enter at the end of a heading starts a fresh normal paragraph
      Enter: ({ editor }) => {
        const { $anchor } = editor.state.selection;
        if ($anchor.parent.type.name === this.name) {
          return editor.commands.splitBlock() && editor.commands.setNode('paragraph');
        }
        return false;
      },
    };
  },
});

// 2. Custom Inline Research Mark ([check this later])
const ResearchMark = Mark.create({
  name: 'research',
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-research]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-research': 'true', class: 'research-tag' }), 0];
  },

  addInputRules() {
    return [
      markInputRule({
        find: /\[([^\[\]]+)\]$/,
        type: this.type,
      }),
    ];
  },
});

// 3. Passive Story Bible Underline Plugin (Decorations only — never mutates prose)
const biblePluginKey = new PluginKey('bibleHighlight');

function buildBibleDecorations(doc: any, entries: BibleEntry[]): DecorationSet {
  if (!entries.length) return DecorationSet.empty;

  const termMap = new Map<string, BibleEntry>();
  const allTerms: string[] = [];

  for (const entry of entries) {
    const candidates = [entry.term, ...(entry.aliases || [])].filter(Boolean);
    for (const c of candidates) {
      const lower = c.toLowerCase();
      if (!termMap.has(lower)) {
        termMap.set(lower, entry);
        allTerms.push(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    }
  }

  if (!allTerms.length) return DecorationSet.empty;
  // Sort longest first so multi-word names match before single words
  allTerms.sort((a, b) => b.length - a.length);
  const regex = new RegExp(`\\b(${allTerms.join('|')})\\b`, 'gi');

  const decorations: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(node.text)) !== null) {
      const entry = termMap.get(match[0].toLowerCase());
      if (!entry) continue;
      decorations.push(
        Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
          class: 'bible-term',
          'data-bible-id': entry.id,
          title: `${entry.term} (${entry.category}): ${entry.notes}`,
        })
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

function createBibleExtension(getEntries: () => BibleEntry[]) {
  return Extension.create({
    name: 'bibleHighlight',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: biblePluginKey,
          state: {
            init: (_, { doc }) => buildBibleDecorations(doc, getEntries()),
            apply: (tr, old) =>
              tr.docChanged || tr.getMeta('refreshBible')
                ? buildBibleDecorations(tr.doc, getEntries())
                : old,
          },
          props: {
            decorations(state) {
              return this.getState(state);
            },
          },
        }),
      ];
    },
  });
}

// 4. Editor Factory
export interface StudioEditorOptions {
  element: HTMLElement;
  initialMarkdown: string;
  getBibleEntries: () => BibleEntry[];
  onChange: (markdown: string) => void;
}

export function createStudioEditor(opts: StudioEditorOptions): Editor {
  return new Editor({
    element: opts.element,
    extensions: [
      StarterKit.configure({
        heading: false, // Replaced by OutlineHeading
      }),
      OutlineHeading,
      ResearchMark,
      createBibleExtension(opts.getBibleEntries),
    ],
    content: markdownToTiptapJSON(opts.initialMarkdown),
    onUpdate({ editor }) {
      opts.onChange(tiptapJSONToMarkdown(editor.getJSON()));
    },
  });
}