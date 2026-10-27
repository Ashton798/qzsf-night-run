"""生成道路掩膜（供 server/scripts/snap-routes.js 使用）

只保留“粗”白色道路像素：用距离变换把文字笔画（细）过滤掉，
保留宽度 >= 5px 的道路。输出为 1 字节/像素的原始掩膜。
"""
import json
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

CAL = json.load(open('docs/campus-wide-cal.json'))
z, x0, y0 = CAL['z'], CAL['x0'], CAL['y0']


def ll2px(lng, lat):
    n = 2 ** z
    x = (lng + 180) / 360 * n
    la = np.radians(lat)
    y = (1 - np.log(np.tan(la) + 1 / np.cos(la)) / np.pi) / 2 * n
    return (x - x0) * 256, (y - y0) * 256


X1, Y1 = ll2px(118.6650, 24.8745)
X2, Y2 = ll2px(118.6790, 24.8630)
X1, Y1, X2, Y2 = int(X1), int(Y1), int(X2), int(Y2)
W, H = X2 - X1, Y2 - Y1

im = Image.open('docs/campus-wide-z18.png').convert('RGB')
a = np.asarray(im).astype(int)[Y1:Y1 + H, X1:X1 + W]
white = (a[:, :, 0] >= 248) & (a[:, :, 1] >= 248) & (a[:, :, 2] >= 248)

dt = ndi.distance_transform_edt(white)
road = dt >= 1.2          # 半宽>=1.2px => 宽度>=2.4px，兼顾细步道
# 去掉孤立小块（图标/标点）
lab, n = ndi.label(road)
sizes = ndi.sum(road, lab, range(1, n + 1))
keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 18])
print('road px', int(keep.sum()), 'of', W * H)

keep.astype(np.uint8).tofile('docs/road-mask.bin')
json.dump({'w': W, 'h': H, 'X1': X1, 'Y1': Y1, 'z': z, 'x0': x0, 'y0': y0},
          open('docs/road-mask-meta.json', 'w'))
print('saved docs/road-mask.bin', W, 'x', H)
