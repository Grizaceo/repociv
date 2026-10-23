"""Build durable local before/after sheets from real Playwright screenshots."""
import os
from pathlib import Path
import shutil
import json

import numpy as np
from PIL import Image, ImageDraw

from repair_family_geometry import ASSETS, ROOT


def build():
    scratch = Path(os.environ['TMPDIR']) / 'repociv-meshy/family-repairs'
    outputs = []
    for asset in ASSETS:
        destination = ROOT / 'assets-src/meshy' / asset / 'repair-v003/review'
        destination.mkdir(parents=True, exist_ok=True)
        sheet = Image.new('RGB', (1200, 2150), '#202c36')
        draw = ImageDraw.Draw(sheet)
        metrics = {}
        for row, view in enumerate(['iso', 'front', 'back', 'right', 'left']):
            metrics[view] = {}
            for column, variant in enumerate(['original', 'repair']):
                source = scratch / asset / variant / (view + '.png')
                image = Image.open(source).convert('RGB')
                if image.size != (1600, 1000):
                    raise ValueError('Screenshot viewport differs from expected crop')
                pixels = np.asarray(image)[:, 400:]
                black = int((pixels.max(axis=2) < 30).sum())
                metrics[view][variant + '_black_pixels_max_rgb_lt_30'] = black
                if variant == 'repair' and black:
                    raise ValueError(f'Black-wedge regression: {asset}/{view}: {black} pixels')
                target = destination / variant
                target.mkdir(exist_ok=True)
                shutil.copyfile(source, target / (view + '.png'))
                crop = image.crop((550, 200, 1550, 900))
                crop.thumbnail((600, 400))
                sheet.paste(crop, (column * 600, row * 430 + 30))
                label = f'{asset}  {"ORIGINAL" if variant == "original" else "REPAIR v003"}  {view}'
                draw.text((column * 600 + 10, row * 430 + 8), label, fill='white')
        sheet.save(destination / 'comparison.png')
        (destination / 'pixel-regression.json').write_text(json.dumps(metrics, indent=2) + '\n')
        outputs.append(str(destination / 'comparison.png'))
    return outputs


if __name__ == '__main__':
    print('\n'.join(build()))
