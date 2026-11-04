# Pliego 0.4.0 — ver qué cambió

Pliego ya abría un borrador junto a su revisión. Ahora también marca lo que cambia entre los dos.

## Ver qué cambió

Al abrir dos textos con **Dos textos**, Pliego los coteja:

- en **ocre**, lo que solo está en el primer texto;
- en **verde**, lo que solo está en el segundo;
- lo común queda limpio.

La barra del documento indica cuántos pasajes cambian. Las flechas **↑ ↓** llevan los dos paneles a la vez al pasaje anterior o siguiente, y **Marcar cambios** apaga y enciende las marcas.

El cotejo empareja primero los párrafos y después compara palabras dentro de cada pareja; un párrafo que solo existe en un lado se marca entero. Se comparan palabras, no formato. Las marcas se actualizan mientras editas y no modifican los archivos.

## Descarga

Descarga **Pliego-0.4.0-win32-x64.zip**, descomprime la carpeta completa y abre **Pliego.exe**. No necesitas Node.js. **SHA256SUMS.txt** permite comprobar que la descarga es idéntica a la publicada.

Si Windows SmartScreen avisa al abrirlo, pulsa **Más información** y después **Ejecutar de todas formas**: el ejecutable todavía no tiene firma digital.

Si ya tienes Pliego instalado con **Install-Pliego.ps1**, cierra la aplicación y vuelve a ejecutar el instalador de esta versión. Se conservan los documentos y los datos de lectura locales.
