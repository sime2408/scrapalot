/**
 * Note Templates Catalog — curated entry-point templates for the Notes
 * editor.
 *
 * Each template seeds:
 *   - a skeleton markdown body (headings + placeholder prompts in italics)
 *   - a category that drives sidebar grouping (backend)
 *   - an optional default Research Context that the consumer can apply on
 *     create (e.g. "Academic article" defaults to all academic collections;
 *     "Personal journal" defaults to none + web off)
 *
 * Backend `note_templates` table + gRPC follow later — until
 * then, the catalog ships frontend-only and templates apply directly in the
 * editor when a new note is created.
 */

export type NoteTemplateCategory =
  | 'academic'
  | 'writing'
  | 'social'
  | 'personal'
  | 'review';

export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  category: NoteTemplateCategory;
  /** Approximate target word count to surface in the gallery card. */
  expectedWordCount?: string;
  /** Markdown skeleton inserted into the new note. */
  skeleton: string;
  /** Suggested default research context — consumer applies it on create. */
  defaultResearchContext?: {
    webSearchEnabled?: boolean;
    agenticRoutingEnabled?: boolean;
  };
  /** Lucide icon name as a hint to the gallery card (the gallery maps it). */
  icon?: string;
}

export const NOTE_TEMPLATES_CATALOG: NoteTemplate[] = [
  // ─────────────────────────────────────────────────────────────────
  // Academic
  // ─────────────────────────────────────────────────────────────────
  {
    id: 'academic-imrad',
    name: 'Academic article (IMRaD)',
    description: 'Introduction, Methods, Results, Discussion. Formal scholarly tone with inline citations.',
    category: 'academic',
    expectedWordCount: '~3000 words',
    icon: 'Microscope',
    defaultResearchContext: { agenticRoutingEnabled: true, webSearchEnabled: true },
    skeleton: `# [Title — 60–120 characters]

*[Abstract — 150–250 words covering motivation, method, key finding, implication.]*

## Introduction

*[Background, the gap in the literature, the research question, and what this paper contributes — 2–3 paragraphs.]*

## Methods

*[Data sources, analysis approach, tools used. Be reproducible.]*

## Results

*[Findings with inline citations. Lead with the headline result.]*

## Discussion

*[Interpretation, limits, future work, implications for practice.]*

## References
`,
  },
  {
    id: 'peer-review',
    name: 'Peer review report',
    description: 'Summary · Strengths · Weaknesses · Recommendations. Constructive, rigorous tone.',
    category: 'review',
    expectedWordCount: '~800 words',
    icon: 'ClipboardCheck',
    defaultResearchContext: { agenticRoutingEnabled: true },
    skeleton: `# Peer review: [Manuscript title]

**Reviewer:** [Your name]
**Recommendation:** [Accept / Minor revisions / Major revisions / Reject]

## Summary

*[1–2 paragraphs restating what the paper does in your own words.]*

## Strengths

- *[Concrete strength with reference to a section]*
- *[…]*

## Weaknesses

- *[Concrete weakness with reference to a section]*
- *[…]*

## Specific comments

1. *[Page / line — issue + suggestion]*
2. *[…]*

## Recommendations

*[Top 3 changes that would meaningfully improve the manuscript.]*
`,
  },
  {
    id: 'literature-review',
    name: 'Literature review',
    description: 'Background, current state, gaps, synthesis across the field.',
    category: 'academic',
    expectedWordCount: '~2500 words',
    icon: 'BookOpen',
    defaultResearchContext: { agenticRoutingEnabled: true, webSearchEnabled: true },
    skeleton: `# Literature review: [Topic]

## Scope

*[What you are reviewing and why. Include the inclusion / exclusion criteria.]*

## Background

*[Foundational works the rest of the literature builds on.]*

## Current state

*[Recent (last 5 years) findings, organized thematically — not chronologically.]*

## Gaps and tensions

*[Where the literature disagrees, what remains untested, where methodology is thin.]*

## Synthesis

*[Your own integrative framing. Don't just list — connect.]*

## References
`,
  },
  {
    id: 'research-proposal',
    name: 'Research proposal',
    description: 'Problem · significance · approach · timeline. For grant or thesis intake.',
    category: 'academic',
    expectedWordCount: '~2000 words',
    icon: 'FileSearch',
    defaultResearchContext: { agenticRoutingEnabled: true },
    skeleton: `# Research proposal: [Title]

## Problem statement

*[The problem in 1 paragraph. Why it matters — to whom.]*

## Significance

*[What changes if you succeed. Who benefits.]*

## Background and prior work

*[3–5 most relevant references with one-sentence summaries.]*

## Research questions

1. *[Specific, falsifiable question]*
2. *[…]*

## Approach

*[Methodology, datasets, instruments. Be specific enough that another researcher could replicate.]*

## Timeline

| Month | Milestone |
|---|---|
| 1–2 | *[…]* |
| 3–6 | *[…]* |
| 7–12 | *[…]* |

## Expected outcomes

*[Concrete deliverables — papers, software, datasets.]*

## References
`,
  },

  // ─────────────────────────────────────────────────────────────────
  // Writing
  // ─────────────────────────────────────────────────────────────────
  {
    id: 'medium-article',
    name: 'Medium article',
    description: 'Long-form narrative with pull-quotes. Conversational-authoritative.',
    category: 'writing',
    expectedWordCount: '1200–2000 words',
    icon: 'FileText',
    skeleton: `# [Hook headline — make a reader stop scrolling]

*[Subtitle — one sentence promise of what the reader gets.]*

[Opening paragraph — start with a vivid scene, a startling statistic, or a contrarian claim. Earn the next paragraph.]

## [First section heading]

[Body. Short paragraphs. One idea per paragraph.]

> [Pull-quote — the most quotable line.]

## [Second section heading]

[…]

## [Third section heading]

[…]

## What to take away

[3 bullet points the reader should remember tomorrow.]

— *[Your name]*
`,
  },
  {
    id: 'blog-post',
    name: 'Blog post',
    description: 'Conversational 5–6 paragraphs, social-friendly TL;DR at the end.',
    category: 'writing',
    expectedWordCount: '~600 words',
    icon: 'PenLine',
    skeleton: `# [Headline]

[Hook — what made you write this today?]

[Context — the problem or observation you're addressing.]

[Heart of the post — your insight, story, or argument.]

[Implication — what the reader should think or do differently.]

[Close — a question, a call to action, or a memorable image.]

---

**TL;DR:** *[One sentence the reader can copy-paste into a tweet.]*
`,
  },
  {
    id: 'philosophical-essay',
    name: 'Philosophical essay',
    description: 'Thesis → argument → counterexample → synthesis. Bridge-mode friendly.',
    category: 'writing',
    expectedWordCount: '~2000 words',
    icon: 'Brain',
    defaultResearchContext: { agenticRoutingEnabled: true },
    skeleton: `# [Question or claim as the title]

## Thesis

*[State the position you will defend in 1–2 sentences.]*

## The argument

*[Build the case. Define key terms. Cite traditions or thinkers where relevant.]*

## Strongest objection

*[Steel-man the position you disagree with. Treat it generously.]*

## Reply

*[Show why your position survives the objection — or refine the thesis.]*

## Implications

*[What follows if the thesis holds. For practice, for other questions, for self-understanding.]*

## Sources consulted
`,
  },

  // ─────────────────────────────────────────────────────────────────
  // Social
  // ─────────────────────────────────────────────────────────────────
  {
    id: 'social-thread',
    name: 'Social media thread',
    description: 'Numbered 8–12 post sequence. Hook, body, payoff.',
    category: 'social',
    expectedWordCount: '~400 words',
    icon: 'MessageCircle',
    skeleton: `# Thread: [Topic]

**1/** *[Hook — make people stop. Concrete, specific, contrarian, or vulnerable.]*

**2/** *[Set the stakes — why this matters to the reader right now.]*

**3/** *[First insight or beat of the story.]*

**4/** *[Second beat — escalate.]*

**5/** *[Third beat — reveal the hidden mechanism / surprise.]*

**6/** *[Practical takeaway #1.]*

**7/** *[Practical takeaway #2.]*

**8/** *[Synthesis — what does it all mean.]*

**9/** *[Soft CTA — follow / save / share, or a question to invite replies.]*
`,
  },

  // ─────────────────────────────────────────────────────────────────
  // Personal
  // ─────────────────────────────────────────────────────────────────
  {
    id: 'personal-journal',
    name: 'Personal journal',
    description: 'First-person reflective. No citations, no research. Private by default.',
    category: 'personal',
    expectedWordCount: 'Any length',
    icon: 'Notebook',
    defaultResearchContext: { webSearchEnabled: false, agenticRoutingEnabled: false },
    skeleton: `# [Date or mood as the title]

[What happened today — outwardly.]

[How I noticed it inwardly — what I felt, what surprised me.]

[What I'm carrying forward — a question, a lesson, a gentle recognition.]
`,
  },
  {
    id: 'reading-notes',
    name: 'Reading notes',
    description: 'Per-chapter or per-section capture. Quotes + my reaction + open questions.',
    category: 'personal',
    expectedWordCount: 'As long as needed',
    icon: 'BookmarkCheck',
    defaultResearchContext: { webSearchEnabled: false },
    skeleton: `# [Source title] — reading notes

**Author:** [Author]
**Section / chapter:** [Where I am]

## Key passages

> *[Quote, with page number]*

> *[Quote, with page number]*

## My reaction

*[What this provoked in me. Where it agrees with or contradicts something I've thought.]*

## Open questions

- *[Question the author raises but doesn't fully answer]*
- *[Something I want to look up next]*

## Connect to

*[Other books / ideas this links to.]*
`,
  },
];

export const NOTE_TEMPLATE_CATEGORY_LABELS: Record<NoteTemplateCategory, string> = {
  academic: 'Academic',
  writing: 'Writing',
  social: 'Social',
  personal: 'Personal',
  review: 'Review',
};

export const NOTE_TEMPLATE_CATEGORIES: NoteTemplateCategory[] = [
  'academic',
  'writing',
  'social',
  'personal',
  'review',
];

export function findTemplateById(id: string): NoteTemplate | undefined {
  return NOTE_TEMPLATES_CATALOG.find((t) => t.id === id);
}
