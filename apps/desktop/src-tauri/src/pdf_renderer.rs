use libloading::Library;
use std::{
    ffi::{c_char, c_int, c_uint, c_void},
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
};

const MAX_RENDERED_BYTES: u64 = 512 * 1024 * 1024;

type DocumentHandle = *mut c_void;
type PageHandle = *mut c_void;
type BitmapHandle = *mut c_void;

type InitLibrary = unsafe extern "C" fn();
type DestroyLibrary = unsafe extern "C" fn();
type LoadMemDocument = unsafe extern "C" fn(*const c_void, c_int, *const c_char) -> DocumentHandle;
type CloseDocument = unsafe extern "C" fn(DocumentHandle);
type GetPageCount = unsafe extern "C" fn(DocumentHandle) -> c_int;
type LoadPage = unsafe extern "C" fn(DocumentHandle, c_int) -> PageHandle;
type ClosePage = unsafe extern "C" fn(PageHandle);
type GetPageWidth = unsafe extern "C" fn(PageHandle) -> f32;
type GetPageHeight = unsafe extern "C" fn(PageHandle) -> f32;
type BitmapCreate = unsafe extern "C" fn(c_int, c_int, c_int) -> BitmapHandle;
type BitmapDestroy = unsafe extern "C" fn(BitmapHandle);
type BitmapFillRect = unsafe extern "C" fn(BitmapHandle, c_int, c_int, c_int, c_int, c_uint);
type BitmapGetBuffer = unsafe extern "C" fn(BitmapHandle) -> *mut c_void;
type BitmapGetStride = unsafe extern "C" fn(BitmapHandle) -> c_int;
type RenderPageBitmap =
    unsafe extern "C" fn(BitmapHandle, PageHandle, c_int, c_int, c_int, c_int, c_int, c_int);
type GetLastError = unsafe extern "C" fn() -> c_uint;

struct Pdfium {
    _library: Library,
    destroy_library: DestroyLibrary,
    load_mem_document: LoadMemDocument,
    close_document: CloseDocument,
    get_page_count: GetPageCount,
    load_page: LoadPage,
    close_page: ClosePage,
    get_page_width: GetPageWidth,
    get_page_height: GetPageHeight,
    bitmap_create: BitmapCreate,
    bitmap_destroy: BitmapDestroy,
    bitmap_fill_rect: BitmapFillRect,
    bitmap_get_buffer: BitmapGetBuffer,
    bitmap_get_stride: BitmapGetStride,
    render_page_bitmap: RenderPageBitmap,
    get_last_error: GetLastError,
}

impl Pdfium {
    fn load(path: &Path) -> Result<Self, String> {
        let library = unsafe { Library::new(path) }
            .map_err(|error| format!("could not load PDFium at {}: {error}", path.display()))?;
        unsafe {
            let init_library = *library
                .get::<InitLibrary>(b"FPDF_InitLibrary\0")
                .map_err(symbol_error("FPDF_InitLibrary"))?;
            let api = Self {
                destroy_library: *library
                    .get::<DestroyLibrary>(b"FPDF_DestroyLibrary\0")
                    .map_err(symbol_error("FPDF_DestroyLibrary"))?,
                load_mem_document: *library
                    .get::<LoadMemDocument>(b"FPDF_LoadMemDocument\0")
                    .map_err(symbol_error("FPDF_LoadMemDocument"))?,
                close_document: *library
                    .get::<CloseDocument>(b"FPDF_CloseDocument\0")
                    .map_err(symbol_error("FPDF_CloseDocument"))?,
                get_page_count: *library
                    .get::<GetPageCount>(b"FPDF_GetPageCount\0")
                    .map_err(symbol_error("FPDF_GetPageCount"))?,
                load_page: *library
                    .get::<LoadPage>(b"FPDF_LoadPage\0")
                    .map_err(symbol_error("FPDF_LoadPage"))?,
                close_page: *library
                    .get::<ClosePage>(b"FPDF_ClosePage\0")
                    .map_err(symbol_error("FPDF_ClosePage"))?,
                get_page_width: *library
                    .get::<GetPageWidth>(b"FPDF_GetPageWidthF\0")
                    .map_err(symbol_error("FPDF_GetPageWidthF"))?,
                get_page_height: *library
                    .get::<GetPageHeight>(b"FPDF_GetPageHeightF\0")
                    .map_err(symbol_error("FPDF_GetPageHeightF"))?,
                bitmap_create: *library
                    .get::<BitmapCreate>(b"FPDFBitmap_Create\0")
                    .map_err(symbol_error("FPDFBitmap_Create"))?,
                bitmap_destroy: *library
                    .get::<BitmapDestroy>(b"FPDFBitmap_Destroy\0")
                    .map_err(symbol_error("FPDFBitmap_Destroy"))?,
                bitmap_fill_rect: *library
                    .get::<BitmapFillRect>(b"FPDFBitmap_FillRect\0")
                    .map_err(symbol_error("FPDFBitmap_FillRect"))?,
                bitmap_get_buffer: *library
                    .get::<BitmapGetBuffer>(b"FPDFBitmap_GetBuffer\0")
                    .map_err(symbol_error("FPDFBitmap_GetBuffer"))?,
                bitmap_get_stride: *library
                    .get::<BitmapGetStride>(b"FPDFBitmap_GetStride\0")
                    .map_err(symbol_error("FPDFBitmap_GetStride"))?,
                render_page_bitmap: *library
                    .get::<RenderPageBitmap>(b"FPDF_RenderPageBitmap\0")
                    .map_err(symbol_error("FPDF_RenderPageBitmap"))?,
                get_last_error: *library
                    .get::<GetLastError>(b"FPDF_GetLastError\0")
                    .map_err(symbol_error("FPDF_GetLastError"))?,
                _library: library,
            };
            init_library();
            Ok(api)
        }
    }

    fn render(
        &self,
        input: &Path,
        output_dir: &Path,
        max_pages: usize,
        width: i32,
    ) -> Result<usize, String> {
        // Loading bytes avoids the platform-specific path encoding used by
        // FPDF_LoadDocument, so documents with non-ASCII names work reliably.
        let bytes = fs::read(input).map_err(|error| error.to_string())?;
        let byte_count = c_int::try_from(bytes.len())
            .map_err(|_| "PDF is too large for the renderer".to_string())?;
        let document = unsafe {
            (self.load_mem_document)(
                bytes.as_ptr().cast::<c_void>(),
                byte_count,
                std::ptr::null(),
            )
        };
        if document.is_null() {
            return Err(format!("PDFium rejected the document (error {})", unsafe {
                (self.get_last_error)()
            }));
        }
        let result = self.render_document(document, output_dir, max_pages, width);
        unsafe { (self.close_document)(document) };
        result
    }

    fn render_document(
        &self,
        document: DocumentHandle,
        output_dir: &Path,
        max_pages: usize,
        target_width: i32,
    ) -> Result<usize, String> {
        fs::create_dir_all(output_dir).map_err(|error| error.to_string())?;
        let page_count = unsafe { (self.get_page_count)(document) }.max(0) as usize;
        let page_count = page_count.min(max_pages);
        let mut rendered_bytes = 0_u64;
        for index in 0..page_count {
            let page = unsafe { (self.load_page)(document, index as c_int) };
            if page.is_null() {
                return Err(format!("PDFium could not load page {}", index + 1));
            }
            let result = self.render_page(page, output_dir, index, target_width);
            unsafe { (self.close_page)(page) };
            rendered_bytes = rendered_bytes
                .checked_add(result?)
                .ok_or_else(|| "rendered page size overflowed".to_string())?;
            if rendered_bytes > MAX_RENDERED_BYTES {
                return Err("rendered PDF exceeds the 512 MiB safety limit".into());
            }
        }
        Ok(page_count)
    }

    fn render_page(
        &self,
        page: PageHandle,
        output_dir: &Path,
        index: usize,
        target_width: i32,
    ) -> Result<u64, String> {
        let page_width = unsafe { (self.get_page_width)(page) };
        let page_height = unsafe { (self.get_page_height)(page) };
        if !page_width.is_finite()
            || !page_height.is_finite()
            || page_width <= 0.0
            || page_height <= 0.0
        {
            return Err(format!("page {} has invalid dimensions", index + 1));
        }
        let width = target_width.clamp(320, 4096);
        let height = ((width as f32 * page_height / page_width).round() as i32).clamp(320, 8192);
        let bitmap = unsafe { (self.bitmap_create)(width, height, 0) };
        if bitmap.is_null() {
            return Err(format!("PDFium could not allocate page {}", index + 1));
        }
        let result = (|| {
            unsafe {
                (self.bitmap_fill_rect)(bitmap, 0, 0, width, height, 0xffff_ffff);
                (self.render_page_bitmap)(bitmap, page, 0, 0, width, height, 0, 0x01 | 0x02);
            }
            self.write_png(
                bitmap,
                output_dir.join(format!("page-{index:04}.png")),
                width,
                height,
            )
        })();
        unsafe { (self.bitmap_destroy)(bitmap) };
        result
    }

    fn write_png(
        &self,
        bitmap: BitmapHandle,
        path: PathBuf,
        width: i32,
        height: i32,
    ) -> Result<u64, String> {
        let buffer = unsafe { (self.bitmap_get_buffer)(bitmap) } as *const u8;
        let stride = unsafe { (self.bitmap_get_stride)(bitmap) };
        if buffer.is_null() || stride < width * 4 {
            return Err("PDFium returned an invalid bitmap buffer".into());
        }
        let pixel_count = (width as usize)
            .checked_mul(height as usize)
            .and_then(|value| value.checked_mul(3))
            .ok_or_else(|| "rendered page dimensions overflowed".to_string())?;
        let mut rgb = Vec::with_capacity(pixel_count);
        let row_bytes = stride as usize;
        for row in 0..height as usize {
            let pixels =
                unsafe { std::slice::from_raw_parts(buffer.add(row * row_bytes), row_bytes) };
            for pixel in pixels[..width as usize * 4].chunks_exact(4) {
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }
        let output = BufWriter::new(File::create(&path).map_err(|error| error.to_string())?);
        let mut encoder = png::Encoder::new(output, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&rgb)
            .map_err(|error| error.to_string())?;
        writer.finish().map_err(|error| error.to_string())?;
        fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| error.to_string())
    }
}

impl Drop for Pdfium {
    fn drop(&mut self) {
        unsafe { (self.destroy_library)() };
    }
}

fn symbol_error(name: &'static str) -> impl FnOnce(libloading::Error) -> String {
    move |error| format!("PDFium is missing {name}: {error}")
}

pub fn run_cli(args: &[String]) -> Option<Result<(), String>> {
    if args.first().map(String::as_str) != Some("--student-center-pdf-renderer") {
        return None;
    }
    let operation = args.get(1).map(String::as_str).unwrap_or("");
    let library = value(args, "--library").map(PathBuf::from);
    let Some(library) = library else {
        return Some(Err("PDF renderer requires --library".into()));
    };
    let result = (|| {
        let pdfium = Pdfium::load(&library)?;
        if operation == "probe" {
            return Ok(());
        }
        if operation != "render" {
            return Err("PDF renderer operation must be probe or render".into());
        }
        let input = value(args, "--input")
            .map(PathBuf::from)
            .ok_or_else(|| "PDF renderer requires --input".to_string())?;
        let output_dir = value(args, "--output-dir")
            .map(PathBuf::from)
            .ok_or_else(|| "PDF renderer requires --output-dir".to_string())?;
        let max_pages = value(args, "--max-pages")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100)
            .clamp(1, 100);
        let width = value(args, "--target-width")
            .and_then(|value| value.parse::<i32>().ok())
            .unwrap_or(2200)
            .clamp(320, 4096);
        let pages = pdfium.render(&input, &output_dir, max_pages, width)?;
        if pages == 0 {
            return Err("PDF contains no renderable pages".into());
        }
        Ok(())
    })();
    Some(result)
}

fn value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

#[cfg(test)]
pub(crate) fn render_for_test(
    library: &Path,
    input: &Path,
    output_dir: &Path,
) -> Result<usize, String> {
    Pdfium::load(library)?.render(input, output_dir, 1, 800)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_normal_desktop_arguments() {
        assert!(run_cli(&["--profile".into(), "student".into()]).is_none());
    }

    #[test]
    fn renderer_mode_requires_a_library() {
        let result = run_cli(&["--student-center-pdf-renderer".into(), "probe".into()]);
        assert!(result.unwrap().unwrap_err().contains("--library"));
    }

    #[test]
    fn rejects_unknown_renderer_operations_before_document_access() {
        let missing = std::env::temp_dir().join("missing-pdfium-library");
        let result = run_cli(&[
            "--student-center-pdf-renderer".into(),
            "unknown".into(),
            "--library".into(),
            missing.to_string_lossy().into_owned(),
        ]);
        assert!(result
            .unwrap()
            .unwrap_err()
            .contains("could not load PDFium"));
    }
}
