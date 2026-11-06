"""Original low-poly glTF props and district social artwork; no downloaded art."""
import json
import math
import struct
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]


def glb_lantern():
    vertices, normals, indices = [], [], []
    rings = [(0.0, .17), (.08, .28), (.25, .4), (.55, .44), (.85, .4), (1.02, .28), (1.1, .17)]
    segments = 16
    for y, radius in rings:
        for i in range(segments):
            angle = math.tau * i / segments
            vertices.extend([radius * math.cos(angle), y, radius * math.sin(angle)])
            normals.extend([math.cos(angle), 0, math.sin(angle)])
    for j in range(len(rings) - 1):
        for i in range(segments):
            a, b = j * segments + i, j * segments + (i + 1) % segments
            indices.extend([a, a + segments, b, b, a + segments, b + segments])
    positions = struct.pack(f'<{len(vertices)}f', *vertices)
    normal_data = struct.pack(f'<{len(normals)}f', *normals)
    index_data = struct.pack(f'<{len(indices)}H', *indices)
    binary = positions + normal_data + index_data
    binary += b'\0' * (-len(binary) % 4)
    doc = {
        "asset": {"version": "2.0", "generator": "Wedding World original lathe prop"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "Paper lantern"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.79, 0.2, 0.24, 1], "metallicFactor": 0, "roughnessFactor": .8}, "emissiveFactor": [.12, .025, .01], "doubleSided": True}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
                        {"buffer": 0, "byteOffset": len(positions), "byteLength": len(normal_data)},
                        {"buffer": 0, "byteOffset": len(positions)+len(normal_data), "byteLength": len(index_data)}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(vertices)//3, "type": "VEC3", "min": [-.44,0,-.44], "max": [.44,1.1,.44]},
                      {"bufferView": 1, "componentType": 5126, "count": len(normals)//3, "type": "VEC3"},
                      {"bufferView": 2, "componentType": 5123, "count": len(indices), "type": "SCALAR"}]
    }
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b' ' * (-len(encoded) % 4)
    output = struct.pack('<III', 0x46546C67, 2, 12+8+len(encoded)+8+len(binary))
    output += struct.pack('<II',len(encoded),0x4E4F534A)+encoded
    output += struct.pack('<II',len(binary),0x004E4942)+binary
    path = ROOT/'public/models/lantern.glb'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(output)


def social_art():
    data=json.loads((ROOT/'shared/world.json').read_text(encoding='utf-8'))
    font_dir=Path('C:/Windows/Fonts')
    def font(size):
        for path in [font_dir/'georgia.ttf', Path('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf')]:
            if path.exists(): return ImageFont.truetype(str(path),size)
        return ImageFont.load_default(size=size)
    out=ROOT/'public/art';out.mkdir(parents=True,exist_ok=True)
    for d in data['districts']:
        im=Image.new('RGB',(1200,630),'#f7f8f2');draw=ImageDraw.Draw(im)
        draw.rectangle((650,0,1200,630),fill=d['floor'])
        draw.ellipse((730,100,1100,650),fill='#93ad8d')
        draw.rectangle((780,275,1050,480),fill='#f0e4cf')
        if d['id']=='india':
            for x in (780,1040):draw.rectangle((x,220,x+14,480),fill=d['color'])
            draw.polygon([(740,220),(915,140),(1090,220)],fill=d['roof'])
            for x in range(785,1050,22):draw.ellipse((x,215,x+12,230),fill='#ecc154')
        elif d['id']=='italy':
            draw.polygon([(745,280),(915,180),(1085,280)],fill=d['roof'])
            for x in (800,885,970):draw.rounded_rectangle((x,330,x+45,420),radius=22,fill=d['color'])
        else:
            draw.polygon([(735,280),(780,240),(915,160),(1050,240),(1095,280)],fill=d['roof'])
            for x in (795,1030):draw.rectangle((x,280,x+15,480),fill=d['color'])
            if d['id']=='japan':
                draw.rectangle((760,400,1070,414),fill=d['color'])
        draw.text((72,75),'Wedding World',font=font(32),fill='#244e43')
        draw.text((70,200),'A moment',font=font(67),fill='#244e43')
        draw.text((70,280),'together.',font=font(67),fill='#244e43')
        draw.text((75,410),d['name'],font=font(31),fill=d['color'])
        draw.text((75,462),d['venue'],font=font(23),fill='#536b61')
        im.save(out/f"{d['id']}.png",optimize=True)


if __name__=='__main__':
    glb_lantern();social_art()
    print('Created original GLB lantern and five reusable district preview images.')
