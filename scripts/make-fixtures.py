from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from docx import Document
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
root.mkdir(parents=True, exist_ok=True)
(root / 'ensayos').mkdir(exist_ok=True)

def pdf(name, title):
    out = root / name
    c = canvas.Canvas(str(out), pagesize=A4)
    width, height = A4
    c.setTitle(title)
    for page in range(1, 3):
        c.bookmarkPage(f'p{page}')
        c.addOutlineEntry('Comienzo' if page == 1 else 'Otra mirada', f'p{page}', 0)
        c.setFillColorRGB(.25, .30, .23)
        c.setFont('Times-Italic', 13)
        c.drawString(66, height - 62, 'CUADERNOS DE LECTURA')
        c.setFillColorRGB(.15, .16, .14)
        c.setFont('Times-Roman', 30)
        c.drawString(66, height - 116, title if page == 1 else 'Otra mirada')
        c.setFont('Times-Roman', 14)
        lines = [
            'La lectura necesita tiempo.',
            'Un libro se abre, pero una idea tarda un poco mas.',
            'Hay frases que conviene dejar respirar antes de seguir.',
            '',
            'Este archivo es una prueba: no pertenece a una edicion real.',
            'La hoja del PDF y el folio impreso son datos distintos.',
        ]
        for i, line in enumerate(lines):
            c.drawString(66, height - 166 - i * 28, line)
        c.setFont('Times-Roman', 12)
        c.drawCentredString(width / 2, 35, str(page + 6))
        c.showPage()
    scan = Image.new('RGB', (900, 1200), '#f7f4ed')
    d = ImageDraw.Draw(scan)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/georgia.ttf', 28)
    except OSError:
        font = ImageFont.load_default()
    d.text((90, 120), 'Una hoja escaneada', fill='#30352d', font=font)
    d.text((90, 200), 'Esta imagen no tiene capa de texto.', fill='#30352d', font=font)
    d.text((440, 1130), '9', fill='#30352d', font=font)
    scan_path = root / 'scan.png'
    scan.save(scan_path)
    c.drawImage(str(scan_path), 0, 0, width, height)
    c.showPage()
    c.save()

pdf('lectura.pdf', 'El tiempo de leer')
pdf('contrapunto.pdf', 'El arte de detenerse')
doc = Document()
doc.add_heading('Un documento de Word', 0)
doc.add_paragraph('Una vista previa para leer sin cambiar el archivo original.')
doc.add_heading('Biblioteca personal', 1)
p = doc.add_paragraph('La lectura necesita ')
p.add_run('tiempo y atencion').bold = True
table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text = 'Archivo'
table.cell(0, 1).text = 'Uso'
table.cell(1, 0).text = 'Word'
table.cell(1, 1).text = 'Vista previa'
doc.save(root / 'ensayos' / 'lectura.docx')
(root / 'apuntes.md').write_text('# Apuntes de lectura\n\nLa lectura necesita tiempo.\n\n## Una idea\n\nUn apunte para retocar.\n', encoding='utf-8')
(root / 'ensayos' / 'nota.txt').write_text('Una nota en texto plano.\nLa lectura necesita tiempo.\n', encoding='utf-8')
print(root)
