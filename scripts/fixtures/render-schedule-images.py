"""Render realistic schedule screenshots for the reader's fixtures.

    python3 scripts/fixtures/render-schedule-images.py
    # then, for each PNG:
    tesseract <png> <name> -l eng --psm 6 tsv

Drawn the way a calendar actually draws a week: hours down a left gutter, and
each block printing its own time range the way Google Calendar, Canvas and
Apple Calendar all do. That last part matters — a block's height is a drawn
rectangle that OCR never sees, so if the times are not written inside the block
there is no way to know how long a class runs. `week-grid-gutter-only` is the
fixture for that case, and the reader must decline it rather than guess.

Rendered at 2x because a screenshot from any modern display is; drawing at 1x
makes the gutter illegible to OCR and would be testing a picture no student
would ever paste.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path("apps/desktop/src-tauri/test-fixtures/schedule")
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

CLASSES = [
    ("PSY 101", "COOR 174", [1, 3, 5], 9.0, 9.833),
    ("MAT 142", "PSA 21", [2, 4], 11.0, 12.25),
    ("CSE 240", "BYAC 110", [1, 3], 13.5, 14.75),
]


def clock(start, end):
    def one(value):
        hour, minute = int(value), round((value - int(value)) * 60)
        suffix = "AM" if hour < 12 else "PM"
        display = hour if hour <= 12 else hour - 12
        return f"{display}:{minute:02d} {suffix}"
    return f"{one(start)} - {one(end)}"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def week_grid(scale=2, dark=False, day_labels=("Mon", "Tue", "Wed", "Thu", "Fri"),
              times_in_block=True):
    W, H = 1100 * scale, 680 * scale
    bg, fg, muted, rule = ("#111827", "#f3f4f6", "#9ca3af", "#374151") if dark else (
        "white", "black", "#4b5563", "#e5e7eb")
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    gutter, top = 110 * scale, 70 * scale
    colw = (W - gutter - 20 * scale) // 5
    hour = 62 * scale

    for i, day in enumerate(day_labels):
        x = gutter + i * colw
        tw = d.textlength(day, font=font(20 * scale, True))
        d.text((x + (colw - tw) / 2, 24 * scale), day, fill=fg, font=font(20 * scale, True))
        d.line([(x, 56 * scale), (x, H - 10 * scale)], fill=rule)

    # The ruler. One column of hours down the side, exactly once.
    for h in range(8, 17):
        y = top + (h - 8) * hour
        label = f"{h if h <= 12 else h - 12}:00 {'AM' if h < 12 else 'PM'}"
        d.text((16 * scale, y - 10 * scale), label, fill=muted, font=font(16 * scale))
        d.line([(gutter, y), (W - 10 * scale, y)], fill=rule)

    for code, room, days, start, end in CLASSES:
        for day in days:
            col = day - 1
            x = gutter + col * colw + 5 * scale
            y0 = top + (start - 8) * hour
            y1 = top + (end - 8) * hour
            fill = "#1e3a5f" if dark else "#dbeafe"
            d.rectangle([x, y0, x + colw - 12 * scale, y1], fill=fill, outline="#6b7280")
            d.text((x + 9 * scale, y0 + 7 * scale), code, fill=fg, font=font(17 * scale, True))
            if times_in_block:
                d.text((x + 9 * scale, y0 + 30 * scale), clock(start, end),
                       fill=fg, font=font(14 * scale))
                d.text((x + 9 * scale, y0 + 50 * scale), room, fill=fg, font=font(14 * scale))
            else:
                d.text((x + 9 * scale, y0 + 30 * scale), room, fill=fg, font=font(14 * scale))
    return img


def class_list(scale=2):
    W, H = 900 * scale, 320 * scale
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.text((30 * scale, 24 * scale), "Course      Days   Start      End        Location",
           fill="black", font=font(17 * scale, True))
    rows = [("PSY 101", "MWF", "9:00 AM", "9:50 AM", "COOR 174"),
            ("MAT 142", "TTh", "11:00 AM", "12:15 PM", "PSA 21"),
            ("CSE 240", "MW", "1:30 PM", "2:45 PM", "BYAC 110")]
    for i, row in enumerate(rows):
        y = (70 + i * 42) * scale
        for x, text in zip((30, 150, 240, 360, 480), row):
            d.text((x * scale, y), text, fill="black", font=font(17 * scale))
    return img


def unreadable(scale=2):
    """Cropped past the headers, low contrast, and rotated off the baseline."""
    img = week_grid(scale=scale)
    img = img.crop((0, 300 * scale, 520 * scale, 560 * scale))
    img = Image.blend(img, Image.new("RGB", img.size, "white"), 0.72)
    return img.rotate(4, expand=True, fillcolor="white")


OUT.mkdir(parents=True, exist_ok=True)
for name, img in [
    ("week-grid", week_grid()),
    ("week-grid-gutter-only", week_grid(times_in_block=False)),
    ("week-grid-dark", week_grid(dark=True)),
    ("week-grid-3x", week_grid(scale=3)),
    ("google-week", week_grid(day_labels=("MON", "TUE", "WED", "THU", "FRI"))),
    ("class-list", class_list()),
    ("unreadable-capture", unreadable()),
]:
    path = OUT / f"{name}.png"
    img.save(path)
    print(f"{name}: {img.size[0]}x{img.size[1]}")
