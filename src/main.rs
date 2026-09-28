//! Local document API and static editor host.

use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const PRODUCT: &str = "XGraph";
const PORT: u16 = 8791;
const OPEN_FORMATS: &[&str] = &["svg", "json", "odg"];
const MAX_FILE_BYTES: u64 = 30 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    store: Arc<DocumentStore>,
    files_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    id: String,
    title: String,
    starred: bool,
    content: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMeta {
    id: String,
    title: String,
    starred: bool,
    updated_at: DateTime<Utc>,
}

impl From<Document> for DocumentMeta {
    fn from(doc: Document) -> Self {
        Self {
            id: doc.id,
            title: doc.title,
            starred: doc.starred,
            updated_at: doc.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDocument {
    title: Option<String>,
    starred: Option<bool>,
    content: Option<Value>,
}

struct DocumentStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl DocumentStore {
    fn open(root: PathBuf) -> Result<Self, ApiError> {
        fs::create_dir_all(&root).map_err(internal)?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    fn path(&self, id: &str) -> Result<PathBuf, ApiError> {
        Uuid::parse_str(id).map_err(|_| bad("Invalid document ID"))?;
        Ok(self.root.join(format!("{id}.json")))
    }

    fn read(&self, id: &str) -> Result<Document, ApiError> {
        let path = self.path(id)?;
        if !path.is_file() {
            return Err(not_found("Document not found"));
        }
        let data = fs::read(path).map_err(internal)?;
        serde_json::from_slice(&data).map_err(internal)
    }

    fn write(&self, doc: &Document) -> Result<(), ApiError> {
        let path = self.path(&doc.id)?;
        let temp = self.root.join(format!("{}.tmp", Uuid::new_v4()));
        let data = serde_json::to_vec_pretty(doc).map_err(internal)?;
        {
            let mut file = fs::File::create(&temp).map_err(internal)?;
            file.write_all(&data).map_err(internal)?;
            file.sync_all().map_err(internal)?;
        }
        if let Err(e) = fs::rename(&temp, &path) {
            let _ = fs::remove_file(&temp);
            return Err(internal(e));
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<DocumentMeta>, ApiError> {
        let _guard = self.lock.lock().map_err(internal)?;
        let mut docs: Vec<DocumentMeta> = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(internal)? {
            let path = entry.map_err(internal)?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(data) = fs::read(&path) {
                if let Ok(doc) = serde_json::from_slice::<Document>(&data) {
                    docs.push(doc.into());
                }
            }
        }
        docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(docs)
    }

    fn create(&self, body: SaveDocument) -> Result<Document, ApiError> {
        let _guard = self.lock.lock().map_err(internal)?;
        let now = Utc::now();
        let doc = Document {
            id: Uuid::new_v4().to_string(),
            title: clean_title(body.title.unwrap_or_else(|| "Untitled drawing".into())),
            starred: body.starred.unwrap_or(false),
            content: body.content.unwrap_or_else(|| serde_json::json!({})),
            created_at: now,
            updated_at: now,
        };
        self.write(&doc)?;
        Ok(doc)
    }

    fn update(&self, id: &str, body: SaveDocument) -> Result<Document, ApiError> {
        let _guard = self.lock.lock().map_err(internal)?;
        let mut doc = self.read(id)?;
        if let Some(title) = body.title {
            doc.title = clean_title(title);
        }
        if let Some(starred) = body.starred {
            doc.starred = starred;
        }
        if let Some(content) = body.content {
            doc.content = content;
        }
        doc.updated_at = Utc::now();
        self.write(&doc)?;
        Ok(doc)
    }

    fn delete(&self, id: &str) -> Result<(), ApiError> {
        let _guard = self.lock.lock().map_err(internal)?;
        let path = self.path(id)?;
        if !path.is_file() {
            return Err(not_found("Document not found"));
        }
        fs::remove_file(path).map_err(internal)
    }
}

fn clean_title(value: String) -> String {
    let text: String = value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    if text.is_empty() {
        "Untitled drawing".into()
    } else {
        text
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"error": self.message})),
        )
            .into_response()
    }
}
fn bad(msg: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: msg.into(),
    }
}
fn not_found(msg: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::NOT_FOUND,
        message: msg.into(),
    }
}
fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: err.to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    size: u64,
}
#[derive(Deserialize)]
struct FilePath {
    path: String,
}
#[derive(Serialize)]
struct OpenedFile {
    name: String,
    content: String,
}
#[derive(Deserialize)]
struct ExportBody {
    title: String,
    format: String,
    content: String,
}

fn file_path(root: &FsPath, name: &str) -> Result<PathBuf, ApiError> {
    if name.is_empty()
        || name.chars().any(|c| {
            matches!(
                c,
                '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        })
        || name == "."
        || name == ".."
    {
        return Err(bad("Invalid file name"));
    }
    let ext = FsPath::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !OPEN_FORMATS.contains(&ext.as_str()) {
        return Err(bad("Unsupported file format"));
    }
    Ok(root.join(name))
}
fn read_file(root: &FsPath, name: &str) -> Result<OpenedFile, ApiError> {
    let path = file_path(root, name)?;
    let real_root = fs::canonicalize(root).map_err(internal)?;
    let real_path = fs::canonicalize(&path).map_err(|_| not_found("File not found"))?;
    if !real_path.starts_with(&real_root) {
        return Err(bad("File is outside Documents"));
    }
    let meta = fs::metadata(&real_path).map_err(|_| not_found("File not found"))?;
    if !meta.is_file() {
        return Err(bad("Not a file"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(bad("File exceeds 30 MB"));
    }
    let bytes = fs::read(real_path).map_err(internal)?;
    let content = decode_open_content(name, &bytes)?;
    Ok(OpenedFile {
        name: name.into(),
        content,
    })
}

fn decode_open_content(name: &str, bytes: &[u8]) -> Result<String, ApiError> {
    if !name.to_ascii_lowercase().ends_with(".odg") {
        return String::from_utf8(bytes.to_vec()).map_err(|_| bad("File must be UTF-8 text"));
    }
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|_| bad("Invalid ODG package"))?;
    let mut mimetype = String::new();
    archive
        .by_name("mimetype")
        .map_err(|_| bad("ODG package has no mimetype"))?
        .take(256)
        .read_to_string(&mut mimetype)
        .map_err(|_| bad("Invalid ODG mimetype"))?;
    if mimetype.trim() != "application/vnd.oasis.opendocument.graphics" {
        return Err(bad("Not an OpenDocument drawing"));
    }
    if let Ok(mut custom) = archive.by_name("XGraph/document.json") {
        if custom.size() > MAX_FILE_BYTES {
            return Err(bad("Drawing exceeds 30 MB"));
        }
        let mut content = String::new();
        custom
            .read_to_string(&mut content)
            .map_err(|_| bad("Invalid XGraph drawing"))?;
        return Ok(content);
    }
    let mut content = String::new();
    archive
        .by_name("content.xml")
        .map_err(|_| bad("ODG package has no drawing"))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|_| bad("Invalid drawing XML"))?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(bad("Drawing XML exceeds 30 MB"));
    }
    let has_other_shapes = [
        "<draw:rect",
        "<draw:ellipse",
        "<draw:circle",
        "<draw:line",
        "<draw:polygon",
        "<draw:polyline",
        "<draw:custom-shape",
        "<draw:path",
        "<draw:text-box",
    ]
    .iter()
    .any(|tag| content.contains(tag));
    if !has_other_shapes && content.contains("<draw:image") {
        let svg_files: Vec<String> = archive
            .file_names()
            .filter(|name| {
                name.starts_with("Pictures/") && name.to_ascii_lowercase().ends_with(".svg")
            })
            .map(str::to_string)
            .collect();
        if svg_files.len() == 1 {
            let mut svg = String::new();
            archive
                .by_name(&svg_files[0])
                .map_err(internal)?
                .take(MAX_FILE_BYTES + 1)
                .read_to_string(&mut svg)
                .map_err(|_| bad("Invalid embedded SVG"))?;
            if svg.len() as u64 > MAX_FILE_BYTES {
                return Err(bad("Embedded SVG exceeds 30 MB"));
            }
            return Ok(svg);
        }
    }
    Ok(content)
}

fn odg_package(value: &str) -> Result<Vec<u8>, ApiError> {
    let payload: Value = serde_json::from_str(value).map_err(|_| bad("Invalid drawing export"))?;
    let document = payload
        .get("document")
        .ok_or_else(|| bad("Missing drawing model"))?;
    let svg = payload
        .get("svg")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("Missing SVG drawing"))?;
    if !svg.trim_start().starts_with("<svg") {
        return Err(bad("Invalid SVG drawing"));
    }
    let width = document
        .get("width")
        .and_then(Value::as_f64)
        .unwrap_or(1200.0)
        .clamp(100.0, 4000.0)
        * 2.54
        / 96.0;
    let height = document
        .get("height")
        .and_then(Value::as_f64)
        .unwrap_or(800.0)
        .clamp(100.0, 4000.0)
        * 2.54
        / 96.0;
    let content_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:automatic-styles/><office:body><office:drawing><draw:page draw:name="Page 1" draw:master-page-name="Default"><draw:frame draw:name="XGraph drawing" svg:x="0cm" svg:y="0cm" svg:width="{width:.3}cm" svg:height="{height:.3}cm"><draw:image xlink:href="Pictures/drawing.svg" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/svg+xml"><text:p/></draw:image></draw:frame></draw:page></office:drawing></office:body></office:document-content>"#
    );
    let styles_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:styles/><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" fo:page-width="{width:.3}cm" fo:page-height="{height:.3}cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>"#
    );
    let manifest = r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.graphics"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/drawing.svg" manifest:media-type="image/svg+xml"/><manifest:file-entry manifest:full-path="XGraph/document.json" manifest:media-type="application/json"/></manifest:manifest>"#;
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes, method) in [
        (
            "mimetype",
            b"application/vnd.oasis.opendocument.graphics".as_slice(),
            CompressionMethod::Stored,
        ),
        (
            "content.xml",
            content_xml.as_bytes(),
            CompressionMethod::Deflated,
        ),
        (
            "styles.xml",
            styles_xml.as_bytes(),
            CompressionMethod::Deflated,
        ),
        (
            "Pictures/drawing.svg",
            svg.as_bytes(),
            CompressionMethod::Deflated,
        ),
        (
            "XGraph/document.json",
            value.as_bytes(),
            CompressionMethod::Deflated,
        ),
        (
            "META-INF/manifest.xml",
            manifest.as_bytes(),
            CompressionMethod::Deflated,
        ),
    ] {
        archive
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(method),
            )
            .map_err(internal)?;
        archive.write_all(bytes).map_err(internal)?;
    }
    Ok(archive.finish().map_err(internal)?.into_inner())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let data_dir = std::env::var("XGRAPH_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("documents")
        });
    let static_dir = std::env::var("XGRAPH_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static"));
    let files_dir = std::env::var("XGRAPH_FILES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::document_dir().unwrap_or_else(|| data_dir.clone()));
    fs::create_dir_all(&files_dir)?;
    let state = AppState {
        store: Arc::new(DocumentStore::open(data_dir)?),
        files_dir,
    };
    let spa =
        ServeDir::new(&static_dir).not_found_service(ServeFile::new(static_dir.join("index.html")));
    let api = Router::new()
        .route("/health", get(health))
        .route("/documents", get(list_documents).post(create_document))
        .route(
            "/documents/{id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route("/files", get(list_files))
        .route("/files/open", post(open_file))
        .route("/files/launch", get(open_launch_file))
        .route("/files/import", post(import_file))
        .route("/files/decode", post(decode_file))
        .route("/files/docs-dir", get(files_dir_info))
        .route("/export", post(export_file));
    let app = Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(DefaultBodyLimit::max(
            (MAX_FILE_BYTES + 1024 * 1024) as usize,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("{PRODUCT} listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(serde_json::json!({"ok": true, "app": PRODUCT, "mode": "local", "formats": OPEN_FORMATS}))
}
async fn files_dir_info(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::json!({"path": state.files_dir.display().to_string()}))
}
async fn list_documents(
    State(state): State<AppState>,
) -> Result<Json<Vec<DocumentMeta>>, ApiError> {
    Ok(Json(state.store.list()?))
}
async fn create_document(
    State(state): State<AppState>,
    Json(body): Json<SaveDocument>,
) -> Result<(StatusCode, Json<Document>), ApiError> {
    Ok((StatusCode::CREATED, Json(state.store.create(body)?)))
}
async fn get_document(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Document>, ApiError> {
    Ok(Json(state.store.read(&id)?))
}
async fn update_document(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SaveDocument>,
) -> Result<Json<Document>, ApiError> {
    Ok(Json(state.store.update(&id, body)?))
}
async fn delete_document(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.store.delete(&id)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn list_files(State(state): State<AppState>) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let mut files = Vec::new();
    for entry in fs::read_dir(&state.files_dir).map_err(internal)? {
        let entry = entry.map_err(internal)?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(path) = file_path(&state.files_dir, &name) {
            if let Ok(meta) = fs::metadata(path) {
                if meta.is_file() {
                    files.push(FileEntry {
                        name,
                        size: meta.len(),
                    });
                }
            }
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(Json(files))
}
async fn open_file(
    State(state): State<AppState>,
    Json(body): Json<FilePath>,
) -> Result<Json<OpenedFile>, ApiError> {
    Ok(Json(read_file(&state.files_dir, &body.path)?))
}

#[derive(Deserialize)]
struct LaunchQuery {
    token: String,
}

async fn open_launch_file(Query(query): Query<LaunchQuery>) -> Result<Json<OpenedFile>, ApiError> {
    let token = std::env::var("XGRAPH_LAUNCH_TOKEN").map_err(|_| bad("No launch file"))?;
    if query.token != token {
        return Err(bad("Invalid launch token"));
    }
    let path =
        PathBuf::from(std::env::var("XGRAPH_LAUNCH_FILE").map_err(|_| bad("No launch file"))?);
    let meta = fs::metadata(&path).map_err(|_| not_found("Launch file not found"))?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(bad("Launch file must be a file under 30 MB"));
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| bad("Invalid file name"))?;
    file_path(path.parent().unwrap_or(FsPath::new(".")), name)?;
    let content = decode_open_content(name, &fs::read(&path).map_err(internal)?)?;
    Ok(Json(OpenedFile {
        name: name.into(),
        content,
    }))
}
async fn import_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<OpenedFile>, ApiError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| bad(e.to_string()))?
        .ok_or_else(|| bad("No file uploaded"))?;
    let name = field
        .file_name()
        .ok_or_else(|| bad("Missing file name"))?
        .to_string();
    let _ = file_path(&state.files_dir, &name)?;
    let bytes = field.bytes().await.map_err(|e| bad(e.to_string()))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(bad("File exceeds 30 MB"));
    }
    let content = decode_open_content(&name, &bytes)?;
    // Preserve imports in the user's Documents folder without overwriting an existing file.
    let path = file_path(&state.files_dir, &name)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                bad("File already exists")
            } else {
                internal(e)
            }
        })?;
    file.write_all(&bytes).map_err(internal)?;
    Ok(Json(OpenedFile { name, content }))
}

#[derive(Deserialize)]
struct NameQuery {
    name: String,
}

async fn decode_file(
    Query(query): Query<NameQuery>,
    bytes: Bytes,
) -> Result<Json<OpenedFile>, ApiError> {
    file_path(FsPath::new("."), &query.name)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(bad("File exceeds 30 MB"));
    }
    let content = decode_open_content(&query.name, &bytes)?;
    Ok(Json(OpenedFile {
        name: query.name,
        content,
    }))
}
fn export_type(format: &str) -> Option<(&'static str, &'static str)> {
    match format {
        "json" => Some(("json", "application/json")),
        "csv" => Some(("csv", "text/csv; charset=utf-8")),
        "svg" => Some(("svg", "image/svg+xml")),
        "mml" => Some(("mml", "application/mathml+xml")),
        "tex" => Some(("tex", "text/plain; charset=utf-8")),
        _ => None,
    }
}
async fn export_file(Json(body): Json<ExportBody>) -> Result<Response, ApiError> {
    if body.content.len() as u64 > MAX_FILE_BYTES {
        return Err(bad("Export exceeds 30 MB"));
    }
    if body.format == "odg" {
        let filename = export_filename(&body.title, "odg");
        let mut res = Response::new(Body::from(odg_package(&body.content)?));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.oasis.opendocument.graphics"),
        );
        res.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&content_disposition(&filename))
                .map_err(|_| bad("Invalid export file name"))?,
        );
        return Ok(res);
    }
    let (ext, mime) = export_type(&body.format).ok_or_else(|| bad("Unsupported export format"))?;
    let filename = export_filename(&body.title, ext);
    let mut res = Response::new(Body::from(body.content));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    res.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&filename))
            .map_err(|_| bad("Invalid export file name"))?,
    );
    Ok(res)
}

fn export_filename(title: &str, ext: &str) -> String {
    let stem: String = clean_title(title.to_string())
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{stem}.{ext}")
}

fn content_disposition(filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn odg_drawing_roundtrip_and_type_check() {
        let value = r##"{"document":{"width":200,"height":120,"shapes":[]},"svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"120\"></svg>"}"##;
        let package = odg_package(value).unwrap();
        assert_eq!(decode_open_content("example.odg", &package).unwrap(), value);
        assert!(decode_open_content("example.odg", b"not a zip").is_err());
    }

    #[test]
    fn export_header_accepts_unicode_and_windows_punctuation() {
        let name = export_filename("Résumé: 2026?", "svg");
        assert_eq!(name, "Résumé_ 2026_.svg");
        let value = content_disposition(&name);
        assert!(HeaderValue::from_str(&value).is_ok());
        assert!(value.contains("filename*=UTF-8''R%C3%A9sum%C3%A9_%202026_.svg"));
    }

    #[test]
    fn documents_survive_save_update_and_delete() {
        let root = std::env::temp_dir().join(format!("{}-{}", PRODUCT, Uuid::new_v4()));
        let store = DocumentStore::open(root.clone()).unwrap();
        let created = store
            .create(SaveDocument {
                title: Some("Example".into()),
                starred: Some(false),
                content: Some(serde_json::json!({"value": 1})),
            })
            .unwrap();
        assert_eq!(store.read(&created.id).unwrap().content["value"], 1);
        assert_eq!(store.list().unwrap().len(), 1);
        let updated = store
            .update(
                &created.id,
                SaveDocument {
                    title: None,
                    starred: Some(true),
                    content: Some(serde_json::json!({"value": 2})),
                },
            )
            .unwrap();
        assert!(updated.starred);
        assert_eq!(store.read(&created.id).unwrap().content["value"], 2);
        store.delete(&created.id).unwrap();
        assert!(store.list().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_names_cannot_escape_documents() {
        let root = FsPath::new("/tmp/documents");
        assert!(file_path(root, &format!("example.{}", OPEN_FORMATS[0])).is_ok());
        for bad_name in [
            "../secret.json",
            "..\\secret.json",
            "/etc/passwd",
            "bad:name.json",
            "note.exe",
        ] {
            assert!(file_path(root, bad_name).is_err(), "accepted {bad_name}");
        }
    }
}
