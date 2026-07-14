'use strict';
// Formats a translated cue for on-screen display: dialogue goes one speaker per
// line, and an over-long single line is balance-wrapped into two lines. This is
// purely cosmetic — it never changes cue timing.
const MAX_LINE = 42; // conventional subtitle character budget per line

function splitDialogue(text) {
  const t = text.trim();
  if (!/^[-–—]/.test(t)) return [t];
  return t.split(/\s+(?=[-–—])/).map(p => p.trim()).filter(Boolean);
}

function balanceWrap(text, maxLine = MAX_LINE) {
  if (text.length <= maxLine) return [text];
  const words = text.split(/\s+/);
  if (words.length < 2) return [text];
  let best = null;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const diff = Math.abs(l1.length - l2.length);
    if (diff < bestDiff) { bestDiff = diff; best = [l1, l2]; }
  }
  return best || [text];
}

function formatCueText(text, maxLine = MAX_LINE) {
  const dialogue = splitDialogue(text);
  if (dialogue.length >= 2) return dialogue.join('\n');
  return balanceWrap(text, maxLine).join('\n');
}

function formatCues(cues, maxLine = MAX_LINE) {
  return cues.map(c => ({ ...c, text: formatCueText(c.text, maxLine) }));
}

module.exports = { formatCueText, formatCues, balanceWrap, splitDialogue, MAX_LINE };
