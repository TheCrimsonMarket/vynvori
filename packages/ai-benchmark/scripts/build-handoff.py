"""Build an honest report/contact sheet and a secret-free, reproducible handoff."""
from pathlib import Path
from collections import defaultdict
import csv
import hashlib
import json
import shutil
import zipfile
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
REPORT = ROOT / 'results' / 'report'


def latest_records():
    records = {}
    for line in (ROOT / 'results' / 'runs' / 'ledger.jsonl').read_text(encoding='utf-8').splitlines():
        row = json.loads(line)
        records[row['runId']] = row
    return [r for r in records.values() if r['mode'] == 'live' and r['attempts'] > 0]


def contact_sheet():
    samples = json.loads((REPORT / 'review-samples.json').read_text(encoding='utf-8'))
    styles = getSampleStyleSheet()
    story = [Paragraph('Vynvori / Blind Artwork Review', styles['Title']),
             Paragraph(f'{len(samples)} generated samples. Model names, costs and provenance mapping are withheld from this contact sheet. Score independently before unblinding.', styles['BodyText']),
             Spacer(1, 12)]
    if not samples:
        story.append(Paragraph('No real generated artwork is available. Dry-run tasks must not receive art scores.', styles['BodyText']))
    for offset in range(0, len(samples), 4):
        if offset:
            story.append(PageBreak())
            story.append(Paragraph('Vynvori / Anonymous Samples', styles['Heading1']))
        grid = []
        for index in range(offset, min(offset + 4, len(samples)), 2):
            row = []
            for sample in samples[index:index+2]:
                asset = REPORT / sample['artifact']
                item = [Paragraph(escape(f"{sample['sampleId']} / {sample['caseId']} / {sample['operation']}"), styles['Heading3']),
                        Image(str(asset), width=228, height=304)]
                if sample.get('sourceSampleId'):
                    item.append(Paragraph(escape('Source: ' + sample['sourceSampleId']), styles['BodyText']))
                row.append(item)
            if len(row) == 1:
                row.append('')
            grid.append(row)
        table = Table(grid, colWidths=[245, 245])
        table.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('BOTTOMPADDING', (0,0), (-1,-1), 10)]))
        story.append(table)
    SimpleDocTemplate(str(REPORT / 'contact-sheet.pdf'), pagesize=A4,
                      rightMargin=40, leftMargin=40, topMargin=35, bottomMargin=35,
                      title='Vynvori blind artwork contact sheet').build(story)
    shutil.copy2(REPORT / 'contact-sheet.pdf', ROOT / 'results' / 'review' / 'contact-sheet.pdf')


def documentation(records):
    total = sum(r['billing']['amountUsd'] or 0 for r in records)
    groups = defaultdict(list)
    for r in records:
        groups[(r['modelId'], r['operation'])].append(r)
    table = ['| Model | Stage | Delivered / requests | Usage USD | Native print gate |',
             '|---|---|---:|---:|---|']
    for (model, operation), rows in sorted(groups.items()):
        cost = sum(r['billing']['amountUsd'] or 0 for r in rows)
        delivered = sum(r['status'] == 'completed' for r in rows)
        gate = 'N/A' if not delivered else 'See per-image manifest; physical confirmation pending'
        table.append(f'| {model} | {operation} | {delivered}/{len(rows)} | {cost:.6f} | {gate} |')
    full = '\n'.join(table)
    unresolved = sum(r['status'] in ('unknown', 'running') for r in records)
    completed = sum(r['status'] == 'completed' for r in records)
    memo = f'''# Founder decision memo

## 1. Answer

Use OpenRouter as the funded primary gateway and keep fal as a specialized extension. This is a management recommendation, not a model-quality winner. Standard/premium/preview/refinement winners and runner-up routes are N/A until both blind reviews and applicable production gates pass.

## 2. Evidence

{completed} delivered images from {len(records)} submitted requests; {unresolved} unresolved requests. Provider-reported usage charges total **US${total:.6f}**, within the US$10 authorization and US$9.50 inference cap. Invoice-confirmed spending is a separate field; do not treat usage as an invoice. See the generated CSV for p50/p95 latency, output checksums, PPI, alpha and error reasons.

{full}

Blind artwork scores and accepted counts remain N/A until two independent reviews. The technical inspection uses provisional DTF, 300 x 400 mm, 300 PPI. Native output failures cannot be overridden by attractive artwork. Small-placement suitability differs from full-zone suitability.

## 3. Pricing

Minimum proposed top-up: US$5. Final credit denomination, per-operation price, standard/premium bundle and redemption rate remain N/A. Measured API cost is available; accepted-design and full-session cost need reviewers plus processing/payment/funding-fee assumptions. The simulator preserves 3x/3.5x/4x scenario slots without inventing those values.

## 4. Known risks

One concept trial per brief; no physical print tests; single common mascot edit source; abstract procedural moodboards; token-billing variability; unconfirmed production fees. Nano Banana 2.1 returned two unbilled 429s and was explicitly replaced by Nano Banana 2. fal/Ideogram and Higgsfield remain untested. Seedream's exact reseller territory terms need confirmation before a US-serving production route. Catalog model IDs are not guarantees of immutable weights.

## 5. Decisions required from founders

Import two independent blind score files; adjudicate disagreements; choose qualified operation/tier routes; obtain supplier print specifications and physical samples; reconcile usage with provider exports/receipts; provide payment/processing and garment-margin inputs; approve digital-download/gallery/resale rights and any redemption entitlement. No extra API spending or account funding is assumed.

## 6. Suggested next business-plan work

Resume design-studio UX and manufacturing/export feasibility with these real assets and unresolved gates. Keep naming/trademark, full-order unit economics and checkout implementation separate. Re-run a larger repeat-trial benchmark only if required by inconclusive evidence or changed model behavior.
'''
    (ROOT / 'docs' / '08-founder-decision-memo.md').write_text(memo, encoding='utf-8')
    summary = f'''# Vynvori AI benchmark results

Start with `docs/08-founder-decision-memo.md`, then review `results/report/contact-sheet.pdf` or `results/review/blind-review.html` before opening model/cost mappings.

Status: **live screening executed; human acceptance and production qualification pending**.

- Delivered: {completed} images from {len(records)} requests.
- Provider-reported usage: US${total:.6f}; invoice classification remains separate.
- Unresolved requests: {unresolved}.
- Budget: US$10 total / US$9.50 inference / fal US$0.
- Four working model families plus an explicitly recorded unavailable Google candidate.
- Human scores, accepted-design price, credit denomination and production winners: N/A pending founders.

Two reviewers should receive only `results/review` plus `docs/04-evaluation-rubric.md` and dataset briefs/references. Do not show raw costs/models or `data/blind-mapping.json` before independent scoring. The full-resolution anonymous derivatives and common-source pairing are included in the review folder.

`code` contains the reproducible workspace package, lockfile, TypeScript adapters/router, CLI, test suite, exact config and scripts. Use Node 22.23+ and `npm ci` from `code`, then see `code/packages/ai-benchmark/README.md`. Credentials are intentionally excluded. `results/runs` preserves request state events and manifests, while `results/artifacts` preserves original provider files.

No physical prints, invoice evidence, processing allocation, wallet charges, deployment, garment orders or actual customer-credit economy were performed. See the reports for clear pending/untested distinctions.
'''
    (ROOT / 'RESULTS-README.md').write_text(summary, encoding='utf-8')
    api_table = '\n\n## Measured API stage costs\n\n' + full + '\n\nThese are usage costs per attempted stage, not costs per accepted design.\n'
    economics = ROOT / 'docs' / '05-unit-economics.md'
    original = economics.read_text(encoding='utf-8').split('\n\n## Measured API stage costs')[0]
    economics.write_text(original + api_table, encoding='utf-8')


def package_handoff():
    target = WORKSPACE / 'output' / 'vynvori-ai-benchmark-results'
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'RESULTS-README.md', target / 'README.md')
    shutil.copy2(ROOT / 'SOURCES.md', target / 'SOURCES.md')
    for name in ('docs', 'data', 'fixtures'):
        shutil.copytree(ROOT / name, target / name, dirs_exist_ok=True)
    for name in ('runs', 'artifacts', 'report', 'review'):
        shutil.copytree(ROOT / 'results' / name, target / 'results' / name, dirs_exist_ok=True)
    shutil.copy2(ROOT / 'results' / 'private' / 'blind-map.json', target / 'data' / 'blind-mapping.json')
    code = target / 'code'
    code.mkdir(exist_ok=True)
    for name in ('package.json', 'package-lock.json', '.env.example', '.gitignore'):
        shutil.copy2(WORKSPACE / name, code / name)
    code_module = code / 'packages' / 'ai-benchmark'
    code_module.mkdir(parents=True, exist_ok=True)
    for name in ('src', 'tests', 'scripts', 'config', 'fixtures', 'data', 'docs'):
        shutil.copytree(ROOT / name, code_module / name, dirs_exist_ok=True)
    for name in ('package.json', 'tsconfig.json', 'README.md', 'SOURCES.md'):
        shutil.copy2(ROOT / name, code_module / name)
    environment = '''# Environment and validation

Access/run date: 12 October 2026; user timezone Asia/Dhaka. Ledger times are ISO UTC.

Windows PowerShell; Node 22.23.3; npm 10.9.9; TypeScript 7.0.2; tsx 4.23.15; sharp 0.35.5; @types/node 22.19.15. Exact dependencies and integrity hashes are in code/package-lock.json. Python PDF generation uses bundled reportlab, pypdf and Pillow; the bundled interpreter path is host-specific.

Validation: npm run typecheck; npm test; zero-call dry-run; read-only key cap check; live preflight model/provider capabilities and pricing comparison; live concept/edit/final requests; native artifact checksum verification; final report export and handoff SHA-256 inventory. Actual validation output is in data/validation.txt when supplied.

Environment variables: OPENROUTER_API_KEY supplied locally (redacted/never copied), FAL_KEY not used. Key/account identifiers and keys are excluded. Lifetime key cap is $9.50 without periodic reset. This handoff contains no .env file, node_modules, package cache or private key-status files.

Reproduction from code: npm ci; npm run typecheck; npm test; npm run benchmark -- dry-run. Copy .env.example to .env locally and use a newly approved funded key only for an authorized live run. See package README for pending-score and reconciliation commands.
'''
    (target / 'environment.md').write_text(environment, encoding='utf-8')
    hashes = []
    for file in sorted(target.rglob('*')):
        if file.is_file() and file.name != 'CHECKSUMS.sha256':
            hashes.append(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.relative_to(target).as_posix())
    (target / 'CHECKSUMS.sha256').write_text('\n'.join(hashes) + '\n', encoding='utf-8')
    zip_path = target.with_suffix('.zip')
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(target.rglob('*')):
            if file.is_file():
                archive.write(file, Path(target.name) / file.relative_to(target))
    print(json.dumps({'handoff': str(target), 'zip': str(zip_path), 'files': len(hashes) + 1}))


if __name__ == '__main__':
    contact_sheet()
    documentation(latest_records())
    package_handoff()
