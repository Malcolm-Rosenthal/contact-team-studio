import type { JSONContent } from '@tiptap/core';

export type OutlineType = 'part' | 'chapter' | 'scene' | 'beat' | 'sub-beat';

export const OUTLINE_LEVELS: Record<OutlineType, number> = {
  part: 1,
  chapter: 2,
  scene: 3,
  beat: 4,
  'sub-beat': 5,
};

export interface BibleEntry {
  id: string;
  term: string;
  aliases: string[];
  category: string;
  notes: string;
}

const OUTLINE_LINE_RE = /^\[\[([^/\]]+)\/(.+)\]\]$/;

/**
 * Parses inline markdown (*italic*, **bold**, ***bold+italic***, [research])
 * into Tiptap text nodes with marks.
 */
function parseInline(text: string): JSONContent[] {
  const nodes: JSONContent[] = [];
  // Matches: ***both***, **bold**, *italic*, or [research] (not followed by '(')
  const tokenRe = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\[\]]+\](?!\())/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push({
        type: 'text',
        text: token.slice(3, -3),
        marks: [{ type: 'bold' }, { type: 'italic' }],
      });
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push({
        type: 'text',
        text: token.slice(2, -2),
        marks: [{ type: 'bold' }],
      });
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'italic' }],
      });
    } else if (token.startsWith('[') && token.endsWith(']')) {
      nodes.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'research' }],
      });
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return nodes;
}

/**
 * Converts a plain manuscript.md string into a Tiptap JSON document.
 */
export function markdownToTiptapJSON(md: string): JSONContent {
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const content: JSONContent[] = [];

  for (const rawBlock of blocks) {
    const trimmed = rawBlock.trim();
    if (!trimmed) continue;

    const outlineMatch = trimmed.match(OUTLINE_LINE_RE);
    if (outlineMatch) {
      const rawType = outlineMatch[1].trim().toLowerCase() as OutlineType;
      const name = outlineMatch[2].trim();
      const outlineType: OutlineType = rawType in OUTLINE_LEVELS ? rawType : 'scene';

      content.push({
        type: 'outlineHeading',
        attrs: { outlineType },
        content: name ? [{ type: 'text', text: name }] : [],
      });
      continue;
    }

    const inlineNodes = parseInline(trimmed);
    content.push({
      type: 'paragraph',
      content: inlineNodes.length ? inlineNodes : undefined,
    });
  }

  if (content.length === 0) {
    content.push({ type: 'paragraph' });
  }

  return { type: 'doc', content };
}

/**
 * Serializes a Tiptap JSON document back into clean manuscript.md text.
 */
export function tiptapJSONToMarkdown(doc: JSONContent): string {
  if (!doc.content) return '';

  const lines: string[] = [];

  for (const block of doc.content) {
    if (block.type === 'outlineHeading') {
      const outlineType = (block.attrs?.outlineType as OutlineType) || 'scene';
      const title = (block.content || []).map((n) => n.text || '').join('').trim();
      lines.push(`[[${outlineType}/${title}]]`);
      continue;
    }

    if (block.type === 'paragraph') {
      if (!block.content || block.content.length === 0) continue;

      const text = block.content
        .map((node) => {
          if (node.type !== 'text' || !node.text) return '';
          const marks = new Set((node.marks || []).map((m) => m.type));
          let out = node.text;

          if (marks.has('research')) {
            return `[${out}]`;
          }
          if (marks.has('bold') && marks.has('italic')) {
            out = `***${out}***`;
          } else if (marks.has('bold')) {
            out = `**${out}**`;
          } else if (marks.has('italic')) {
            out = `*${out}*`;
          }
          return out;
        })
        .join('');

      if (text.trim()) lines.push(text);
    }
  }

  return lines.join('\n\n') + '\n';
}