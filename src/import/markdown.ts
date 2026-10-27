import { chunkText } from "../llm/extract";
import { MEMORY_CONTENT_MAX_CHARS } from "../shared/limits";

/** Sections shorter than this are skipped (cloud BRAIN_MEMORY_IMPORT_MIN_TEXT_CHARS). */
export const IMPORT_MIN_SECTION_CHARS = 24;

export type Frontmatter = {
  title?: string;
  tags: string[];
};

export type MarkdownSection = {
  /** Stable within the file: heading slug plus occurrence. */
  key: string;
  content: string;
};

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

/** Just enough YAML for Obsidian frontmatter: title and tags (inline or list). */
export function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: { tags: [] }, body: text };
  const frontmatter: Frontmatter = { tags: [] };
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const field = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (key === "title" && value.trim()) frontmatter.title = unquote(value);
    if (key === "tags" || key === "tag") {
      if (value.trim().startsWith("[")) {
        frontmatter.tags = value.replace(/[[\]]/g, "").split(",").map(unquote).filter(Boolean);
      } else if (value.trim()) {
        frontmatter.tags = value.split(/[,\s]+/).map(unquote).filter(Boolean);
      } else {
        while (lines[index + 1]?.match(/^\s*-\s+/)) {
          index += 1;
          frontmatter.tags.push(unquote(lines[index].replace(/^\s*-\s+/, "")));
        }
      }
    }
  }
  frontmatter.tags = frontmatter.tags.map((tag) => tag.replace(/^#/, ""));
  return { frontmatter, body: text.slice(match[0].length) };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

type RawSection = { heading: string | null; level: number; lines: string[] };

/** Split on headings outside code fences. */
function splitByHeadings(body: string): RawSection[] {
  const sections: RawSection[] = [{ heading: null, level: 0, lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      sections.push({ heading: heading[2], level: heading[1].length, lines: [line] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections.filter((section) => section.lines.join("\n").trim().length > 0);
}

/**
 * Turn one Markdown file into memory-sized mini-docs.
 * A note that fits in one memory stays whole. Longer notes split on their
 * highest heading level, small neighbors merge, oversize parts split by paragraph.
 */
export function splitMarkdown(text: string, title: string): MarkdownSection[] {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (body.length < IMPORT_MIN_SECTION_CHARS) return [];
  const hasTitleHeading = /^#\s+/.test(body);
  const withTitle = hasTitleHeading ? body : `# ${title}\n\n${body}`;
  if (withTitle.length <= MEMORY_CONTENT_MAX_CHARS) return [{ key: "note", content: withTitle }];

  const raw = splitByHeadings(body);
  // Split on the highest heading level that repeats; a lone "# Title" is the title.
  const levelCounts = new Map<number, number>();
  for (const section of raw) {
    if (section.heading) levelCounts.set(section.level, (levelCounts.get(section.level) ?? 0) + 1);
  }
  const levels = [...levelCounts.keys()].sort((a, b) => a - b);
  const topLevel = levels.find((level) => (levelCounts.get(level) ?? 0) >= 2) ?? levels[0] ?? 7;

  let docTitle = title;
  if (raw[0]?.heading && raw[0].level === 1 && topLevel > 1) {
    docTitle = raw[0].heading;
    raw[0] = { heading: null, level: 0, lines: raw[0].lines.slice(1) };
  }

  // Fold deeper headings into their parent top-level section.
  const groups: RawSection[] = [];
  for (const section of raw) {
    const startsGroup = section.heading !== null && section.level === topLevel;
    if (startsGroup || groups.length === 0) groups.push({ ...section, lines: [...section.lines] });
    else groups[groups.length - 1].lines.push(...section.lines);
  }

  // Every section carries the note title so it reads on its own.
  const prefix = `# ${docTitle}\n\n`;
  const budget = MEMORY_CONTENT_MAX_CHARS - prefix.length;
  const parts: Array<{ heading: string | null; text: string }> = [];
  for (const group of groups) {
    const groupText = group.lines.join("\n").trim();
    if (!groupText) continue;
    const last = parts[parts.length - 1];
    if (last && last.text.length + groupText.length + 2 <= budget && last.text.length < budget / 3) {
      last.text = `${last.text}\n\n${groupText}`;
    } else if (groupText.length <= budget) {
      parts.push({ heading: group.heading, text: groupText });
    } else {
      chunkText(groupText, budget, 64).forEach((chunk) => parts.push({ heading: group.heading, text: chunk }));
    }
  }

  const seen = new Map<string, number>();
  return parts
    .filter((part) => part.text.length >= IMPORT_MIN_SECTION_CHARS)
    .map((part) => {
      const slug = slugify(part.heading ?? "intro");
      const occurrence = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, occurrence);
      return { key: occurrence === 1 ? slug : `${slug}-${occurrence}`, content: `${prefix}${part.text}` };
    });
}

/** `[[Note]]`, `[[Note|alias]]`, `[[folder/Note#Heading]]` → "Note". Embeds (`![[…]]`) skipped. */
export function extractWikilinks(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    if (match[1] === "!") continue;
    const target = match[2].trim().split("/").pop();
    if (target) targets.add(target.replace(/\.md$/i, "").toLowerCase());
  }
  return [...targets];
}
