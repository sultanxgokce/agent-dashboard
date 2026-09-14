import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS = path.resolve(HERE, '../agents');

function frontmatter(file) {
  const text = fs.readFileSync(path.join(AGENTS, file), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file} must have frontmatter`);
  return match[1];
}

test('Claude Code plugin agents inherit the parent model', () => {
  const files = fs.readdirSync(AGENTS).filter((name) => name.endsWith('.md'));
  assert.ok(files.length > 0, 'agent definitions must exist');

  for (const file of files) {
    assert.doesNotMatch(frontmatter(file), /^model\s*:/m,
      `${file} must not pin a Claude model; parent model inheritance keeps Codex and Claude sessions aligned`);
  }
});
