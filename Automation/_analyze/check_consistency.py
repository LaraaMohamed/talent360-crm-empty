# -*- coding: utf-8 -*-
"""Static consistency check across the DMS Apps Script project:
  1. Every COLUMNS.BLOCK.KEY referenced is defined in Config.gs
  2. Every SETTINGS_KEYS.KEY referenced is defined
  3. Every SHEETS.KEY referenced is defined
  4. Every locally-called helper function is defined somewhere in the project
"""
import os
import re
from collections import defaultdict

DIR = 'C:/Users/HP/Downloads/Automation/HCM/apps-script-dms'

gs_files = [f for f in os.listdir(DIR) if f.endswith('.gs')]
html_files = [f for f in os.listdir(DIR) if f.endswith('.html')]

src = {}
for f in gs_files:
    with open(os.path.join(DIR, f), encoding='utf-8') as fh:
        src[f] = fh.read()
all_gs = '\n'.join(src.values())

html_src = {}
for f in html_files:
    with open(os.path.join(DIR, f), encoding='utf-8') as fh:
        html_src[f] = fh.read()
all_html = '\n'.join(html_src.values())

config = src['Config.gs']
problems = []

# ---- 1. COLUMNS blocks ----
def parse_nested(varname, text):
    """Parses `var NAME = { BLOCK: { KEY: ..., }, ... };` into {BLOCK: set(KEYS)}."""
    m = re.search(r'var\s+' + varname + r'\s*=\s*\{', text)
    if not m:
        return {}
    i = m.end() - 1
    depth = 0
    for j in range(i, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                body = text[i + 1:j]
                break
    out = {}
    for bm in re.finditer(r'(\w+)\s*:\s*\{([^{}]*)\}', body):
        out[bm.group(1)] = set(re.findall(r'(\w+)\s*:', bm.group(2)))
    return out

columns_blocks = parse_nested('COLUMNS', config)
for ref in sorted(set(re.findall(r'COLUMNS\.(\w+)\.(\w+)', all_gs))):
    block, key = ref
    if block not in columns_blocks:
        problems.append(f'COLUMNS.{block} is not defined in Config.gs')
    elif key not in columns_blocks[block]:
        problems.append(f'COLUMNS.{block}.{key} is not defined in Config.gs')

# ---- 2. flat objects: SETTINGS_KEYS, SHEETS, and CONFIG sub-objects ----
def parse_flat(varname, text):
    m = re.search(r'var\s+' + varname + r'\s*=\s*\{', text)
    if not m:
        return set()
    i = m.end() - 1
    depth = 0
    for j in range(i, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                body = text[i + 1:j]
                break
    # strip nested objects so we only get top-level keys
    flat = re.sub(r'\{[^{}]*\}', '""', body)
    return set(re.findall(r'(\w+)\s*:', flat))

settings_keys = parse_flat('SETTINGS_KEYS', config)
for key in sorted(set(re.findall(r'SETTINGS_KEYS\.(\w+)', all_gs))):
    if key not in settings_keys:
        problems.append(f'SETTINGS_KEYS.{key} is not defined in Config.gs')

sheets_keys = parse_flat('SHEETS', config)
for key in sorted(set(re.findall(r'SHEETS\.(\w+)', all_gs))):
    if key not in sheets_keys:
        problems.append(f'SHEETS.{key} is not defined in Config.gs')

# ---- 3. function definitions vs calls ----
defined = set(re.findall(r'function\s+(\w+)\s*\(', all_gs))
# calls to project-style helpers (trailing underscore) and ui_ endpoints
called = set(re.findall(r'\b(\w+_)\s*\(', all_gs))
builtins_ok = {'AppError_'}
for fn in sorted(called):
    if fn not in defined and fn not in builtins_ok:
        problems.append(f'function {fn}() is called in .gs but never defined')

# ---- 4. google.script.run endpoints called from HTML must exist in .gs ----
endpoints = set(re.findall(r'\.(ui_\w+)\s*\(', all_html))
for ep in sorted(endpoints):
    if ep not in defined:
        problems.append(f'HTML calls google.script.run.{ep}() but it is not defined in any .gs')

# ---- 5. include_() targets must exist ----
for inc in sorted(set(re.findall(r"include_\(\s*'([^']+)'\s*\)", all_html))):
    if f'{inc}.html' not in html_files:
        problems.append(f"include_('{inc}') has no matching {inc}.html")

# ---- 6. createTemplateFromFile targets must exist ----
for tpl in sorted(set(re.findall(r"createTemplateFromFile\(\s*'([^']+)'\s*\)", all_gs))):
    if f'{tpl}.html' not in html_files:
        problems.append(f"createTemplateFromFile('{tpl}') has no matching {tpl}.html")

print(f'.gs files:   {len(gs_files)}')
print(f'.html files: {len(html_files)}')
print(f'functions defined: {len(defined)}')
print(f'ui_ endpoints called from HTML: {len(endpoints)}')
print()
if problems:
    print(f'*** {len(problems)} PROBLEM(S) ***')
    for p in problems:
        print('  -', p)
else:
    print('All references resolve. No problems found.')
