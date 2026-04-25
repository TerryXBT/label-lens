# LabelLens

LabelLens is a mobile-first PWA for recognizing supermarket price labels. It extracts the product name and barcode from a photo, supports manual region selection when OCR needs help, and lets users search or copy the result quickly.

## Features

- Photo upload and camera capture
- OCR for product names and barcodes
- Native barcode detection with a ZXing-based fallback on unsupported browsers
- Smear selection for correcting incomplete product names
- Google Images search links for product names and barcodes
- Copy buttons for recognized text
- Local draft restore after returning from search
- PWA manifest and service worker support

## Usage

Open `index.html` in a browser or deploy the folder as a static site.
