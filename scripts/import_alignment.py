"""Build people.json (VPs, RCs, ACs with phones and time zones) and the tracker's ORG roster
in public/index.html from the Ayvaz Master Alignment workbook.

Usage: python scripts/import_alignment.py "<path to AYVAZ Master Alignment.xlsx>"
Re-run whenever a new alignment file comes out, then commit public/index.html and upload
people.json to Render (rc-tracker > Environment > Secret Files > people.json). people.json has
staff phone numbers, so it is gitignored and index.html gets no phone numbers.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'people.json'
INDEX = ROOT / 'public' / 'index.html'
ORG_BLOCK = re.compile(r'(const ORG = \{\r?\n)(.*?)(\r?\n\};)', re.S)

ROLES = [  # earlier roles win if a name appears twice
    ('VP', 'VP of Operations', 'VP Phone Number'),
    ('RC', 'Region Coach', 'Region Coach Phone'),
    ('AC', 'Area Coach', 'Area Coach Phone'),
]


def clean_name(value):
    """'Freddy (Antonio) Sandoval' -> 'Freddy Sandoval' (matches tracker names)."""
    return re.sub(r'\s+', ' ', re.sub(r'\([^)]*\)', '', str(value))).strip()


def clean_phone(value):
    digits = re.sub(r'\D', '', str(value or ''))
    if len(digits) == 11 and digits.startswith('1'):
        digits = digits[1:]
    return f'+1{digits}' if len(digits) == 10 else None


def store_tz(state, region):
    if region == 'NEW PASO' or state in ('NM', 'CO'):
        return 'America/Denver'  # El Paso, New Mexico, Colorado
    if state in ('TX', 'MN', 'IA', 'FL'):
        return 'America/Chicago'  # Ayvaz FL stores are all in the panhandle
    return 'America/New_York'


def js(value):
    return json.dumps(value, ensure_ascii=False)


def text(value):
    return '' if pd.isna(value) else str(value).strip()


def ac_entry(name, rows, people):
    area = re.sub(r'\D', '', text(rows['Area #'].mode()[0])) if rows['Area #'].notna().any() else ''
    emails = rows['Area Coach Email'].dropna()
    stores = sorted({(text(n), text(s)) for n, s in zip(rows['Ayvaz Store #'], rows['Reference Name'])},
                    key=lambda t: int(t[0]) if t[0].isdigit() else 0)
    return {
        'name': name,
        'area': area,
        'phone': '',  # phones stay server-side in people.json; index.html is public
        'email': text(emails.mode()[0]) if len(emails) else '',
        'stores': [{'num': n, 'name': s} for n, s in stores],
    }


def entry_js(a):
    stores = ','.join('{num:%s,name:%s}' % (js(s['num']), js(s['name'])) for s in a['stores'])
    return '{name:%s,area:%s,phone:%s,email:%s,stores:[%s]}' % (js(a['name']), js(a['area']), js(a['phone']), js(a['email']), stores)


def update_org(df, people):
    """Rewrite the ORG roster in index.html. Keeps the existing tracker users and their order."""
    html = INDEX.read_text(encoding='utf-8')
    match = ORG_BLOCK.search(html)
    if not match:
        sys.exit('Could not find "const ORG = {" block in public/index.html')
    eol = '\r\n' if '\r\n' in match.group(1) else '\n'
    old_block = match.group(2)
    users = re.findall(r'^\s*"([^"]+)"\s*:\s*\{', old_block, re.M)
    old_acs = {}
    for user, body in zip(users, re.split(r'^\s*"[^"]+"\s*:\s*\{', old_block, flags=re.M)[1:]):
        old_acs[user] = set(re.findall(r'\{name:"([^"]+)"', body))

    df = df.assign(rc_clean=df['Region Coach'].map(clean_name), vp_clean=df['VP of Operations'].map(clean_name))
    workbook_rcs = sorted(df['rc_clean'].dropna().unique())
    missing = [u for u in users if u not in people]
    if missing:
        sys.exit(f'Tracker users not in the alignment file: {missing}. Update ORG by hand first.')
    users += [rc for rc in workbook_rcs if rc not in users]

    entries, changes = [], []
    for user in users:
        person = people[user]
        if person['role'] == 'VP':
            rcs = sorted({rc for rc in df.loc[df['vp_clean'] == user, 'rc_clean'].dropna()})
            acs = []
            for rc in rcs:
                rows = df[df['rc_clean'] == rc]
                acs.append({'name': rc, 'area': 'RC-' + ' / '.join(sorted(rows['Region'].dropna().unique())),
                            'phone': '',
                            'email': text(rows['Region Coach Email'].dropna().mode()[0]) if rows['Region Coach Email'].notna().any() else '',
                            'stores': []})
            region = 'ALL (VP)'
        else:
            rows = df[df['rc_clean'] == user]
            acs = sorted((ac_entry(clean_name(raw), ac_rows, people) for raw, ac_rows in rows.groupby('Area Coach')),
                         key=lambda a: a['name'])
            region = ' / '.join(sorted(rows['Region'].dropna().unique()))
        new_names = {a['name'] for a in acs}
        added, removed = sorted(new_names - old_acs.get(user, set())), sorted(old_acs.get(user, set()) - new_names)
        if added or removed:
            changes.append(f'{user}: added {added or "none"}, removed {removed or "none"}')
        lines = [f'  {js(user)}: {{', f'    region:{js(region)},', '    acs:[']
        lines += [f'      {entry_js(a)},' for a in acs]
        lines += ['    ]', '  }']
        entries.append(eol.join(lines))

    new_html = html[:match.start(2)] + (',' + eol).join(entries) + html[match.end(2):]
    INDEX.write_text(new_html, encoding='utf-8', newline='')
    print(f'Updated ORG roster in {INDEX.relative_to(ROOT)} for {len(users)} tracker users')
    for change in changes:
        print('  ', change)


def main(path):
    df = pd.read_excel(path, dtype=str)
    df.columns = [re.sub(r'\s+', ' ', c).strip() for c in df.columns]
    df = df.dropna(subset=['Ayvaz Store #'])
    df['tz'] = [store_tz(s, r) for s, r in zip(df['State'], df['Region'])]

    people, problems = {}, []
    for role, name_col, phone_col in ROLES:
        for raw_name, rows in df.dropna(subset=[name_col]).groupby(name_col):
            name = clean_name(raw_name)
            phones = sorted({clean_phone(p) for p in rows[phone_col]} - {None})
            if not phones:
                problems.append(f'{role} {name}: no phone, skipped')
                continue
            if len(phones) > 1:
                problems.append(f'{role} {name}: several phones {phones}, using {phones[0]}')
            if name in people:
                problems.append(f'{name}: listed as {people[name]["role"]} and {role}, keeping {people[name]["role"]}')
                continue
            people[name] = {
                'role': role,
                'phone': phones[0],
                'tz': Counter(rows['tz']).most_common(1)[0][0],
                'rc': name if role in ('RC', 'VP') else clean_name(rows['Region Coach'].mode()[0]),
                'vp': name if role == 'VP' else clean_name(rows['VP of Operations'].mode()[0]),
            }

    by_phone = Counter(p['phone'] for p in people.values())
    shared = {ph: [n for n, p in people.items() if p['phone'] == ph] for ph, c in by_phone.items() if c > 1}
    for ph, names in shared.items():
        problems.append(f'phone {ph} shared by {names}')

    OUT.write_text(json.dumps(dict(sorted(people.items())), indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {len(people)} people to {OUT.name}:', dict(Counter(p['role'] for p in people.values())))
    print('Time zones:', dict(Counter(p['tz'] for p in people.values())))
    for problem in problems:
        print('WARNING:', problem)
    if shared:
        sys.exit('Fix shared phone numbers before using people.json (texts could reach the wrong person).')

    multi_rc = df.dropna(subset=['Area Coach']).groupby('Area Coach')['Region Coach'].nunique()
    for ac in multi_rc[multi_rc > 1].index:
        print(f'WARNING: AC {clean_name(ac)} is under several RCs; listed under each')
    update_org(df, people)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
