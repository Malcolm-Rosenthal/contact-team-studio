import { OUTLINE_LEVELS, type OutlineType } from './markdown';

export interface OutlineSection {
  id: string;
  index: number; // position in sections array
  type: OutlineType;
  level: number;
  name: string;
  displayNumber?: number; // auto-numbered for part & chapter
  directWords: number;
  cumulativeWords: number;
  bodyBlocks: string[]; // raw markdown paragraphs belonging directly to this heading
}

export interface ResearchItem {
  id: string;
  term: string;
  context: string;
  breadcrumb: string;
  occurrenceIndex: number; // nth occurrence of [term] in the manuscript
}

export interface WavefrontStats {
  totalWords: number;
  totalChapters: number;
  completedChapters: number;
  avgChapterWords: number;
  projectedFinalCount: number;
  daysPassed: number;
  pacePerDay: number;
  projectedFinishDate: string;
}

export interface StatSnapshot {
  timestamp: string;
  totalWords: number;
  totalChapters: number;
  avgChapterWords: number;
  projectedFinalCount: number;
  projectedFinishDate: string;
}

const START_DATE = new Date(2026, 10, 1); // Nov 1, 2026
const OUTLINE_LINE_RE = /^\[\[([^/\]]+)\/(.+)\]\]$/;

function countWords(text: string): number {
  const clean = text.replace(/[\*\[\]]/g, '').trim();
  return clean ? clean.split(/\s+/).length : 0;
}

/**
 * Splits manuscript.md into an ordered list of OutlineSections,
 * preserving any preamble text before the first heading.
 */
export function parseSections(md: string): { preamble: string[]; sections: OutlineSection[] } {
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const preamble: string[] = [];
  const sections: OutlineSection[] = [];

  let partNum = 0;
  let chapterNum = 0;

  for (const block of blocks) {
    const match = block.match(OUTLINE_LINE_RE);
    if (match) {
      const rawType = match[1].trim().toLowerCase() as OutlineType;
      const type: OutlineType = rawType in OUTLINE_LEVELS ? rawType : 'scene';
      const name = match[2].trim();

      let displayNumber: number | undefined;
      if (type === 'part') displayNumber = ++partNum;
      else if (type === 'chapter') displayNumber = ++chapterNum;

      sections.push({
        id: `sec-${sections.length}`,
        index: sections.length,
        type,
        level: OUTLINE_LEVELS[type],
        name,
        displayNumber,
        directWords: 0,
        cumulativeWords: 0,
        bodyBlocks: [],
      });
    } else if (sections.length === 0) {
      preamble.push(block);
    } else {
      const current = sections[sections.length - 1];
      current.bodyBlocks.push(block);
      current.directWords += countWords(block);
    }
  }

  // Compute cumulative words (a section includes all following deeper sections)
  for (let i = 0; i < sections.length; i++) {
    let total = sections[i].directWords;
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= sections[i].level) break;
      total += sections[j].directWords;
    }
    sections[i].cumulativeWords = total;
  }

  return { preamble, sections };
}

/**
 * Serializes preamble + sections back into clean manuscript.md text.
 */
export function serializeSections(preamble: string[], sections: OutlineSection[]): string {
  const out: string[] = [...preamble];
  for (const sec of sections) {
    out.push(`[[${sec.type}/${sec.name}]]`);
    out.push(...sec.bodyBlocks);
  }
  return out.join('\n\n') + '\n';
}

/**
 * Returns the end index (exclusive) of a section's subtree (itself + all deeper children).
 */
export function getSubtreeEnd(sections: OutlineSection[], startIdx: number): number {
  const baseLevel = sections[startIdx].level;
  let end = startIdx + 1;
  while (end < sections.length && sections[end].level > baseLevel) {
    end++;
  }
  return end;
}

/**
 * Extracts all [research] items with surrounding context and chapter breadcrumb.
 */
export function extractResearch(md: string): ResearchItem[] {
  const { sections } = parseSections(md);
  const items: ResearchItem[] = [];
  const tokenRe = /(?<!\[)\[([^\[\]]+)\](?!\]|\()/g;
  const seenCounts = new Map<string, number>();

  let currentChapter = 'Preamble';

  for (const sec of sections) {
    if (sec.type === 'chapter') {
      currentChapter = `Ch. ${sec.displayNumber}: ${sec.name}`;
    } else if (sec.type === 'part' && currentChapter === 'Preamble') {
      currentChapter = `Part ${sec.displayNumber}: ${sec.name}`;
    }

    for (const block of sec.bodyBlocks) {
      let match: RegExpExecArray | null;
      tokenRe.lastIndex = 0;
      while ((match = tokenRe.exec(block)) !== null) {
        const term = match[1];
        const count = seenCounts.get(term) || 0;
        seenCounts.set(term, count + 1);

        const start = Math.max(0, match.index - 45);
        const end = Math.min(block.length, match.index + match[0].length + 45);
        const snippet =
          (start > 0 ? '…' : '') +
          block.slice(start, end).replace(/\s+/g, ' ') +
          (end < block.length ? '…' : '');

        items.push({
          id: `res-${items.length}`,
          term,
          context: snippet,
          breadcrumb: currentChapter,
          occurrenceIndex: count,
        });
      }
    }
  }

  return items;
}

/**
 * Chapter-locked Wavefront Forecaster.
 */
export function calculateWavefront(md: string): WavefrontStats {
  const { preamble, sections } = parseSections(md);
  const totalWords =
    preamble.reduce((sum, b) => sum + countWords(b), 0) +
    sections.reduce((sum, s) => sum + s.directWords, 0);

  const chapters = sections.filter((s) => s.type === 'chapter');
  const totalChapters = chapters.length;

  // Find the last chapter that has any words written (the wavefront)
  let wavefrontIdx = -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (chapters[i].cumulativeWords > 0) {
      wavefrontIdx = i;
      break;
    }
  }

  const completedWords: number[] = [];
  let activeWords = 0;

  chapters.forEach((ch, i) => {
    if (i < wavefrontIdx) completedWords.push(ch.cumulativeWords);
    else if (i === wavefrontIdx) activeWords = ch.cumulativeWords;
  });

  const avgChapterWords =
    completedWords.length > 0
      ? Math.round(completedWords.reduce((a, b) => a + b, 0) / completedWords.length)
      : activeWords;

  const projectedFinalCount =
    totalChapters > 0 && avgChapterWords > 0 ? totalChapters * avgChapterWords : 50000;

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysPassed = Math.max(1, (Date.now() - START_DATE.getTime()) / msPerDay);
  const pacePerDay = totalWords / daysPassed;

  let projectedFinishDate = 'TBD';
  if (pacePerDay > 0 && projectedFinalCount > totalWords) {
    const daysRemaining = (projectedFinalCount - totalWords) / pacePerDay;
    const finish = new Date(Date.now() + daysRemaining * msPerDay);
    projectedFinishDate = finish.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } else if (totalWords >= projectedFinalCount && totalWords > 0) {
    projectedFinishDate = 'Complete!';
  }

  return {
    totalWords,
    totalChapters,
    completedChapters: completedWords.length,
    avgChapterWords,
    projectedFinalCount,
    daysPassed: Math.floor(daysPassed),
    pacePerDay: Math.round(pacePerDay),
    projectedFinishDate,
  };
}