from PIL import Image, ImageDraw

BG = (20, 22, 26, 255)       # --bg
HIGH = (226, 87, 76, 255)    # --accent-high
MED = (232, 163, 61, 255)    # --accent-medium
LOW = (79, 168, 160, 255)    # --accent-low


def rounded_square(size, radius_ratio):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    return img, draw


def draw_stack_mark(draw, size, scale=1.0, offset=(0, 0)):
    # Three bars of decreasing width, stacked, representing the priority spine.
    cx = size / 2 + offset[0]
    bar_h = size * 0.10 * scale
    gap = size * 0.06 * scale
    widths = [size * 0.5 * scale, size * 0.36 * scale, size * 0.22 * scale]
    colors = [HIGH, MED, LOW]
    total_h = bar_h * 3 + gap * 2
    top = size / 2 - total_h / 2 + offset[1]
    radius = bar_h / 2.6

    y = top
    for w, color in zip(widths, colors):
        x0 = cx - w / 2
        x1 = cx + w / 2
        draw.rounded_rectangle([x0, y, x1, y + bar_h], radius=radius, fill=color)
        y += bar_h + gap


def make_icon(path, size, radius_ratio, mark_scale=1.0, offset=(0, 0)):
    img, draw = rounded_square(size, radius_ratio)
    draw_stack_mark(draw, size, scale=mark_scale, offset=offset)
    img.save(path)


if __name__ == "__main__":
    make_icon("/home/claude/task-tracker/public/icons/icon-192.png", 192, 0.22)
    make_icon("/home/claude/task-tracker/public/icons/icon-512.png", 512, 0.22)
    # Maskable icon: keep the mark within the ~80% safe zone, no rounded corners
    # since the OS applies its own mask shape.
    img = Image.new("RGBA", (512, 512), BG)
    draw = ImageDraw.Draw(img)
    draw_stack_mark(draw, 512, scale=0.72)
    img.save("/home/claude/task-tracker/public/icons/icon-maskable-512.png")
    print("icons written")
