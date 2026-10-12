"""Small analysis handoff; preserve full-resolution originals in the main results."""
from pathlib import Path
from io import BytesIO
import json
import shutil
import zipfile
from PIL import Image as PILImage
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Image, Table, TableStyle, PageBreak, Spacer

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
SOURCE = ROOT / 'results' / 'report'
TARGET = WORKSPACE / 'output' / 'vynvori-chatgpt-review'
TARGET.mkdir(parents=True, exist_ok=True)
for name in ('docs', 'fixtures'):
    shutil.copytree(ROOT / name, TARGET / name, dirs_exist_ok=True)
for name in ('SOURCES.md', 'RESULTS-README.md'):
    shutil.copy2(ROOT / name, TARGET / ('README.md' if name == 'RESULTS-README.md' else name))
(TARGET / 'data').mkdir(exist_ok=True)
for name in ('model-manifest.json', 'google-replacement-amendment.json', 'validation.txt'):
    shutil.copy2(ROOT / 'data' / name, TARGET / 'data' / name)
shutil.copy2(ROOT / 'results' / 'private' / 'blind-map.json', TARGET / 'data' / 'blind-mapping.json')
report = TARGET / 'results' / 'report'
report.mkdir(parents=True, exist_ok=True)
for file in SOURCE.iterdir():
    if file.is_file() and file.suffix in ('.csv', '.json', '.jsonl'):
        shutil.copy2(file, report / file.name)
samples = json.loads((SOURCE / 'review-samples.json').read_text(encoding='utf-8'))
styles = getSampleStyleSheet()
story = []
buffers = []
for offset in range(0, len(samples), 4):
    if offset:
        story.append(PageBreak())
    story.append(Paragraph('Vynvori / Anonymous Artwork Samples', styles['Heading1']))
    if offset == 0:
        story.append(Paragraph('Compact visual review: 28 samples. JPEG-compressed previews only; native assets and provenance remain in the full local handoff. Do not infer alpha or print detail from this PDF.', styles['BodyText']))
        story.append(Spacer(1, 8))
    grid = []
    for index in range(offset, min(offset + 4, len(samples)), 2):
        row = []
        for sample in samples[index:index + 2]:
            buffer = BytesIO()
            PILImage.open(SOURCE / sample['artifact']).convert('RGB').save(buffer, format='JPEG', quality=85, optimize=True)
            buffer.seek(0)
            buffers.append(buffer)
            label = f"{sample['sampleId']} / {sample['caseId']} / {sample['operation']}"
            item = [Paragraph(label, styles['Heading3']), Image(buffer, width=216, height=288)]
            if sample.get('sourceSampleId'):
                item.append(Paragraph('Source: ' + sample['sourceSampleId'], styles['BodyText']))
            row.append(item)
        if len(row) == 1:
            row.append('')
        grid.append(row)
    table = Table(grid, colWidths=[240, 240])
    table.setStyle(TableStyle([('VALIGN', (0,0), (-1,-1), 'TOP'), ('BOTTOMPADDING', (0,0), (-1,-1), 8)]))
    story.append(table)
pdf = report / 'contact-sheet.pdf'
SimpleDocTemplate(str(pdf), pagesize=A4, leftMargin=40, rightMargin=40, topMargin=30, bottomMargin=30).build(story)
instructions = '''# Compact ChatGPT analysis package

This package contains the research/protocol/integration reports, measured results, model/sample mapping, briefs/references and a compressed contact sheet. It excludes code, node_modules, full-resolution images, duplicate originals and the scoring web app.

Human scores are currently pending unless blind-scores.csv / scores.json contains imported reviews. Complete both independent reviews before uploading model identities/mapping to a reviewer who must remain blinded. Include the two downloaded reviewer JSON files separately if not yet imported.

The compressed PDF is for visual overview only. It cannot establish native print detail, clean alpha or physical production suitability; use manifest.csv and the print-readiness report for measured technical evidence. Full-resolution originals remain in the full local results folder.

Suggested ChatGPT request: Read the decision memo and reports. Distinguish measured usage, human scores, API-only estimates and unresolved production evidence. Compare the four working families by operation, review print/territory blockers and explain which model selections and credit prices can or cannot yet be supported. Then continue the six-phase Vynvori business plan from the pending founder decisions.
'''
(TARGET / 'UPLOAD-INSTRUCTIONS.md').write_text(instructions, encoding='utf-8')
archive = TARGET.with_suffix('.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
    for file in sorted(TARGET.rglob('*')):
        if file.is_file():
            output.write(file, Path(TARGET.name) / file.relative_to(TARGET))
print(json.dumps({'zip': str(archive), 'zipMiB': round(archive.stat().st_size / 1048576, 2), 'pdfMiB': round(pdf.stat().st_size / 1048576, 2), 'scoresImported': (SOURCE / 'scores.json').exists()}))
