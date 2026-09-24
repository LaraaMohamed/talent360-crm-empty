# -*- coding: utf-8 -*-
"""Brace/paren/bracket balance check for every .gs file, skipping strings,
template literals, regex literals and comments.

The reference checker validated identifiers but not structure, which is how a
stray '}' shipped. This closes that gap.
"""
import os
import sys

DIR = 'C:/Users/HP/Downloads/Automation/HCM/apps-script-dms'
PAIRS = {'}': '{', ')': '(', ']': '['}
OPENERS = set(PAIRS.values())


def scan(text):
    """Yields (index, char) for structural chars only."""
    i = 0
    n = len(text)
    prev_significant = ''
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ''

        # line comment
        if ch == '/' and nxt == '/':
            j = text.find('\n', i)
            i = n if j == -1 else j
            continue
        # block comment
        if ch == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            i = n if j == -1 else j + 2
            continue
        # strings
        if ch in ('"', "'", '`'):
            q = ch
            j = i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == q:
                    break
                j += 1
            i = j + 1
            continue
        # regex literal: '/' in a position where a value may start
        if ch == '/' and prev_significant in ('', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', ';', 'return'):
            j = i + 1
            in_class = False
            closed = False
            while j < n:
                c = text[j]
                if c == '\\':
                    j += 2
                    continue
                if c == '[':
                    in_class = True
                elif c == ']':
                    in_class = False
                elif c == '/' and not in_class:
                    closed = True
                    break
                elif c == '\n':
                    break
                j += 1
            if closed:
                i = j + 1
                continue

        if not ch.isspace():
            prev_significant = ch
        if ch in OPENERS or ch in PAIRS:
            yield i, ch
        i += 1


def line_of(text, index):
    return text.count('\n', 0, index) + 1


problems = []
for fname in sorted(f for f in os.listdir(DIR) if f.endswith('.gs')):
    path = os.path.join(DIR, fname)
    with open(path, encoding='utf-8') as fh:
        text = fh.read()

    stack = []
    for idx, ch in scan(text):
        if ch in OPENERS:
            stack.append((idx, ch))
        else:
            want = PAIRS[ch]
            if not stack:
                problems.append(f'{fname}:{line_of(text, idx)}  stray closing "{ch}"')
                break
            oidx, och = stack.pop()
            if och != want:
                problems.append(
                    f'{fname}:{line_of(text, idx)}  "{ch}" closes "{och}" opened at line {line_of(text, oidx)}')
                break
    else:
        if stack:
            oidx, och = stack[-1]
            problems.append(f'{fname}  unclosed "{och}" opened at line {line_of(text, oidx)}')

    if not any(p.startswith(fname) for p in problems):
        print(f'  OK  {fname}')

print()
if problems:
    print(f'*** {len(problems)} STRUCTURAL PROBLEM(S) ***')
    for p in problems:
        print('  -', p)
    sys.exit(1)
print('All .gs files are structurally balanced.')
