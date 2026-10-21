"""Vestige demo marketplace. Python standard library only."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
# In local development, keep database/uploads inside the project folder.
# On hosting, set VESTIGE_DATA_DIR to a persistent disk mount such as /var/data.
DATA_DIR = Path(os.environ["VESTIGE_DATA_DIR"]) if os.environ.get("VESTIGE_DATA_DIR") else None
INSTANCE_DIR = DATA_DIR if DATA_DIR else BASE_DIR / "instance"
UPLOAD_DIR = (DATA_DIR / "uploads") if DATA_DIR else BASE_DIR / "uploads"
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(INSTANCE_DIR / "vestige.sqlite3")))
MAX_BODY_BYTES = 6 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}
CATEGORIES = {"Atasan", "Outerwear", "Bawahan", "Dress", "Aksesori"}
SIZES = {"XS", "S", "M", "L", "XL", "XXL", "All size"}
CONDITIONS = {"Like new", "Sangat baik", "Baik"}
SESSION_SECONDS = 60 * 60 * 24 * 7
PBKDF2_ITERATIONS = 310_000

INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def initialize_database() -> None:
    conn = connect_db()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('buyer','seller','both')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                price INTEGER NOT NULL CHECK(price > 0),
                category TEXT NOT NULL,
                size TEXT NOT NULL,
                condition TEXT NOT NULL,
                image TEXT NOT NULL,
                seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                seller_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold')),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                buyer_id INTEGER NOT NULL REFERENCES users(id),
                buyer_name TEXT NOT NULL,
                phone TEXT NOT NULL,
                address TEXT NOT NULL,
                total INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'Menunggu konfirmasi',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES products(id),
                title TEXT NOT NULL,
                price INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
            CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
            CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
            CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
            """
        )
        existing = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if existing == 0:
            items = [
                ("Knit vest warna butter", "Vest rajut warna butter yang gampang dipaduin dengan kemeja putih. Ada sedikit tanda pemakaian yang tidak mengganggu.", 68000, "Outerwear", "M", "Sangat baik", "/static/assets/knit-vest.svg", "@ranithrift"),
                ("Baby tee cherry club", "Baby tee katun lembut dengan grafis cherry. Nyaman untuk outfit sehari-hari.", 45000, "Atasan", "S", "Like new", "/static/assets/baby-tee.svg", "@vestige.mila"),
                ("Denim jeans vintage", "Jeans denim biru dengan potongan relaxed. Warna pudar natural, cocok buat gaya vintage.", 89000, "Bawahan", "L", "Sangat baik", "/static/assets/denim-jeans.svg", "@secondstory"),
                ("Floral midi dress", "Dress motif bunga dengan bahan ringan dan siluet flowy. Detail kancing di bagian depan.", 75000, "Dress", "M", "Baik", "/static/assets/floral-dress.svg", "@ranithrift"),
                ("Jaket varsity forest", "Jaket varsity hijau-krem yang hangat untuk layering. Kancing dan jahitan masih berfungsi baik.", 115000, "Outerwear", "L", "Sangat baik", "/static/assets/varsity-jacket.svg", "@vestige.mila"),
                ("Tote bag patchwork", "Tote bag patchwork unik, cukup luas untuk buku dan barang harian. Tiap detail punya karakter sendiri.", 39000, "Aksesori", "All size", "Like new", "/static/assets/tote-bag.svg", "@secondstory"),
                ("Hoodie lilac cloud", "Hoodie warna lilac dengan fit santai. Bagian dalam lembut dan cocok dipakai saat cuaca dingin.", 82000, "Atasan", "XL", "Sangat baik", "/static/assets/lilac-hoodie.svg", "@thriftbykai"),
                ("Pleated skirt cocoa", "Rok plisket warna cokelat dengan jatuh bahan yang manis. Mudah dipadukan dengan atasan polos.", 57000, "Bawahan", "M", "Baik", "/static/assets/pleated-skirt.svg", "@thriftbykai"),
            ]
            conn.executemany(
                """INSERT INTO products
                (title, description, price, category, size, condition, image, seller_id, seller_name, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'available', ?)""",
                [(*item, utc_now()) for item in items],
            )
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        conn.commit()
    finally:
        conn.close()


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        check = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
        return secrets.compare_digest(check.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def public_user(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "email": row["email"], "username": row["username"], "role": row["role"]}


def product_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "title": row["title"], "description": row["description"],
        "price": row["price"], "category": row["category"], "size": row["size"],
        "condition": row["condition"], "image": row["image"],
        "sellerId": row["seller_id"], "sellerName": row["seller_name"],
        "status": row["status"], "createdAt": row["created_at"],
    }


class VestigeHandler(BaseHTTPRequestHandler):
    server_version = "Vestige/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        if getattr(self, "cookie_to_set", None):
            self.send_header("Set-Cookie", self.cookie_to_set)
        super().end_headers()

    def send_bytes(self, status: int, payload: bytes, content_type: str = "application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        self.close_connection = True

    def send_json(self, data: dict, status: int = 200):
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_bytes(status, payload)

    def send_error_json(self, message: str, status: int = 400):
        self.send_json({"error": message}, status)

    def parse_path(self):
        parsed = urlsplit(self.path)
        return unquote(parsed.path), parse_qs(parsed.query, keep_blank_values=True)

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError("Ukuran permintaan tidak valid.", 400)
        if length < 0:
            raise ApiError("Ukuran permintaan tidak valid.", 400)
        if length > MAX_BODY_BYTES:
            raise ApiError("Ukuran permintaan maksimal 6 MB.", 413)
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            raise ApiError("Permintaan tidak lengkap.", 400)
        return body

    def read_json(self) -> dict:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type.lower():
            raise ApiError("Format permintaan harus JSON.", 415)
        try:
            data = json.loads(self.read_body().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError("Data JSON tidak valid.", 400)
        if not isinstance(data, dict):
            raise ApiError("Data permintaan tidak valid.", 400)
        return data

    def read_multipart(self) -> dict:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type.lower():
            raise ApiError("Formulir harus dikirim sebagai multipart/form-data.", 415)
        raw = self.read_body()
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
        )
        if not message.is_multipart():
            raise ApiError("Format unggahan tidak valid.", 400)
        fields = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            payload = part.get_payload(decode=True) or b""
            filename = part.get_filename()
            if filename is not None:
                fields[name] = {"filename": filename, "data": payload, "content_type": part.get_content_type()}
            else:
                charset = part.get_content_charset() or "utf-8"
                fields[name] = payload.decode(charset, errors="replace")
        return fields

    def incoming_session_token(self):
        cookie_header = self.headers.get("Cookie", "")
        try:
            cookie = SimpleCookie()
            cookie.load(cookie_header)
            morsel = cookie.get("ll_session")
            return morsel.value if morsel else ""
        except Exception:
            return ""

    def get_session(self, create: bool = False):
        existing = getattr(self, "request_session", None)
        if existing is not None:
            return existing
        token = self.incoming_session_token()
        conn = connect_db()
        try:
            row = conn.execute(
                "SELECT token, user_id, csrf_token, expires_at FROM sessions WHERE token = ?", (token,)
            ).fetchone() if token else None
            if row and row["expires_at"] > int(time.time()):
                self.request_session = dict(row)
                return self.request_session
            if row:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
            if not create:
                self.request_session = None
                return None
            new_token = secrets.token_urlsafe(32)
            new_csrf = secrets.token_urlsafe(32)
            expires = int(time.time()) + SESSION_SECONDS
            conn.execute(
                "INSERT INTO sessions (token, user_id, csrf_token, expires_at, created_at) VALUES (?, NULL, ?, ?, ?)",
                (new_token, new_csrf, expires, utc_now()),
            )
            conn.commit()
            self.cookie_to_set = self.make_cookie(new_token)
            self.request_session = {"token": new_token, "user_id": None, "csrf_token": new_csrf, "expires_at": expires}
            return self.request_session
        finally:
            conn.close()

    def make_cookie(self, token: str) -> str:
        secure = "; Secure" if os.environ.get("COOKIE_SECURE", "0") == "1" else ""
        return f"ll_session={token}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Lax{secure}"

    def rotate_session(self, user_id: int):
        old = self.get_session(create=False)
        conn = connect_db()
        try:
            if old:
                conn.execute("DELETE FROM sessions WHERE token = ?", (old["token"],))
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            expires = int(time.time()) + SESSION_SECONDS
            conn.execute(
                "INSERT INTO sessions (token, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                (token, user_id, csrf, expires, utc_now()),
            )
            conn.commit()
        finally:
            conn.close()
        self.cookie_to_set = self.make_cookie(token)
        self.request_session = {"token": token, "user_id": user_id, "csrf_token": csrf, "expires_at": expires}
        return csrf

    def require_session_and_csrf(self):
        sess = self.get_session(create=False)
        if not sess or not sess.get("user_id"):
            raise ApiError("Masuk dulu untuk melanjutkan.", 401)
        provided = self.headers.get("X-CSRF-Token", "")
        if not provided or not secrets.compare_digest(sess["csrf_token"], provided):
            raise ApiError("Permintaan tidak valid. Muat ulang halaman dan coba lagi.", 403)
        conn = connect_db()
        try:
            user = conn.execute("SELECT id, email, username, role FROM users WHERE id = ?", (sess["user_id"],)).fetchone()
        finally:
            conn.close()
        if not user:
            raise ApiError("Sesi akun tidak valid. Silakan masuk kembali.", 401)
        return sess, user

    def serve_file(self, file_path: Path, root: Path):
        try:
            resolved_root = root.resolve()
            resolved_file = file_path.resolve()
            if not resolved_file.is_relative_to(resolved_root) or not resolved_file.is_file():
                self.send_bytes(404, b"Not found", "text/plain; charset=utf-8")
                return
            payload = resolved_file.read_bytes()
            mime, _encoding = mimetypes.guess_type(str(resolved_file))
            if resolved_file.suffix.lower() == ".svg":
                mime = "image/svg+xml"
            if not mime:
                mime = "application/octet-stream"
            if mime.startswith("text/") or mime in {"image/svg+xml", "application/javascript", "application/json"}:
                mime += "; charset=utf-8"
            self.send_bytes(200, payload, mime)
        except OSError:
            self.send_bytes(404, b"Not found", "text/plain; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            path, query = self.parse_path()
            if path == "/":
                return self.serve_file(STATIC_DIR / "index.html", STATIC_DIR)
            if path.startswith("/static/"):
                relative = path.removeprefix("/static/")
                return self.serve_file(STATIC_DIR / relative, STATIC_DIR)
            if path.startswith("/uploads/"):
                relative = path.removeprefix("/uploads/")
                return self.serve_file(UPLOAD_DIR / relative, UPLOAD_DIR)
            if path == "/api/products":
                return self.handle_get_products(query)
            if path == "/api/me":
                return self.handle_get_me()
            if path == "/api/my-listings":
                return self.handle_my_listings()
            if path == "/api/my-orders":
                return self.handle_my_orders()
            if path == "/api/my-sales":
                return self.handle_my_sales()
            if path.startswith("/api/"):
                return self.send_error_json("Endpoint tidak ditemukan.", 404)
            return self.send_bytes(404, b"Halaman tidak ditemukan", "text/plain; charset=utf-8")
        except ApiError as error:
            self.send_error_json(error.message, error.status)
        except Exception:
            traceback.print_exc()
            if self.path.startswith("/api/"):
                self.send_error_json("Terjadi kendala di server. Coba lagi.", 500)
            else:
                self.send_bytes(500, b"Server error", "text/plain; charset=utf-8")

    def handle_get_products(self, query):
        search = query.get("search", [""])[0].strip()[:100]
        category = query.get("category", [""])[0].strip()
        size = query.get("size", [""])[0].strip()
        condition = query.get("condition", [""])[0].strip()
        sort = query.get("sort", ["newest"])[0]
        where = ["p.status = 'available'"]
        args = []
        if search:
            where.append("(p.title LIKE ? OR p.description LIKE ? OR p.category LIKE ? OR p.seller_name LIKE ?)")
            pattern = f"%{search}%"
            args.extend([pattern, pattern, pattern, pattern])
        if category in CATEGORIES:
            where.append("p.category = ?"); args.append(category)
        if size in SIZES:
            where.append("p.size = ?"); args.append(size)
        if condition in CONDITIONS:
            where.append("p.condition = ?"); args.append(condition)
        order_by = {"newest": "p.id DESC", "price-low": "p.price ASC", "price-high": "p.price DESC"}.get(sort, "p.id DESC")
        conn = connect_db()
        try:
            rows = conn.execute(f"SELECT p.* FROM products p WHERE {' AND '.join(where)} ORDER BY {order_by}", args).fetchall()
            self.send_json({"products": [product_json(row) for row in rows]})
        finally:
            conn.close()

    def handle_get_me(self):
        sess = self.get_session(create=True)
        user = None
        if sess.get("user_id"):
            conn = connect_db()
            try:
                row = conn.execute("SELECT id, email, username, role FROM users WHERE id = ?", (sess["user_id"],)).fetchone()
                if row:
                    user = public_user(row)
                else:
                    user = None
            finally:
                conn.close()
        self.send_json({"user": user, "csrfToken": sess["csrf_token"]})

    def handle_my_listings(self):
        _sess, user = self.require_session_and_csrf_for_get()
        conn = connect_db()
        try:
            rows = conn.execute("SELECT * FROM products WHERE seller_id = ? ORDER BY id DESC", (user["id"],)).fetchall()
            self.send_json({"products": [product_json(row) for row in rows]})
        finally:
            conn.close()

    def handle_my_orders(self):
        _sess, user = self.require_session_and_csrf_for_get()
        conn = connect_db()
        try:
            rows = conn.execute("SELECT * FROM orders WHERE buyer_id = ? ORDER BY id DESC", (user["id"],)).fetchall()
            result = []
            for row in rows:
                items = conn.execute("SELECT title, price FROM order_items WHERE order_id = ?", (row["id"],)).fetchall()
                result.append({
                    "id": row["id"], "buyerName": row["buyer_name"], "total": row["total"],
                    "status": row["status"], "createdAt": row["created_at"],
                    "items": [{"title": item["title"], "price": item["price"]} for item in items],
                })
            self.send_json({"orders": result})
        finally:
            conn.close()

    def handle_my_sales(self):
        _sess, user = self.require_session_and_csrf_for_get()
        conn = connect_db()
        try:
            rows = conn.execute(
                """SELECT o.id AS order_id, o.buyer_name, o.phone, o.address, o.total, o.status, o.created_at,
                          oi.title AS item_title, oi.price AS item_price
                   FROM orders o
                   JOIN order_items oi ON oi.order_id = o.id
                   JOIN products p ON p.id = oi.product_id
                   WHERE p.seller_id = ?
                   ORDER BY o.id DESC, oi.id ASC""",
                (user["id"],),
            ).fetchall()
            grouped = {}
            for row in rows:
                key = row["order_id"]
                if key not in grouped:
                    grouped[key] = {
                        "id": key, "buyerName": row["buyer_name"], "phone": row["phone"],
                        "address": row["address"], "orderTotal": row["total"],
                        "status": row["status"], "createdAt": row["created_at"], "items": [],
                    }
                grouped[key]["items"].append({"title": row["item_title"], "price": row["item_price"]})
            self.send_json({"sales": list(grouped.values())})
        finally:
            conn.close()

    def require_session_and_csrf_for_get(self):
        sess = self.get_session(create=False)
        if not sess or not sess.get("user_id"):
            raise ApiError("Masuk dulu untuk melanjutkan.", 401)
        conn = connect_db()
        try:
            user = conn.execute("SELECT id, email, username, role FROM users WHERE id = ?", (sess["user_id"],)).fetchone()
        finally:
            conn.close()
        if not user:
            raise ApiError("Sesi akun tidak valid. Silakan masuk kembali.", 401)
        return sess, user

    def do_POST(self):
        try:
            path, _query = self.parse_path()
            if path == "/api/register":
                return self.handle_register()
            if path == "/api/login":
                return self.handle_login()
            if path == "/api/logout":
                return self.handle_logout()
            if path == "/api/listings":
                return self.handle_create_listing()
            if path == "/api/orders":
                return self.handle_create_order()
            if path.startswith("/api/"):
                return self.send_error_json("Endpoint tidak ditemukan.", 404)
            return self.send_bytes(404, b"Not found", "text/plain; charset=utf-8")
        except ApiError as error:
            self.send_error_json(error.message, error.status)
        except Exception:
            traceback.print_exc()
            if self.path.startswith("/api/"):
                self.send_error_json("Terjadi kendala di server. Coba lagi.", 500)
            else:
                self.send_bytes(500, b"Server error", "text/plain; charset=utf-8")

    def handle_register(self):
        data = self.read_json()
        email = str(data.get("email", "")).strip().lower()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        role = str(data.get("role", "both"))
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
            raise ApiError("Masukkan alamat email yang valid.")
        if not 2 <= len(username) <= 32:
            raise ApiError("Nama pengguna harus terdiri dari 2–32 karakter.")
        if len(password) < 8 or len(password) > 128:
            raise ApiError("Kata sandi harus berisi 8–128 karakter.")
        if role not in {"buyer", "seller", "both"}:
            raise ApiError("Pilihan peran akun tidak valid.")
        conn = connect_db()
        try:
            cur = conn.execute(
                "INSERT INTO users (email, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
                (email, username, password_hash(password), role, utc_now()),
            )
            conn.commit()
            user_id = cur.lastrowid
            row = conn.execute("SELECT id, email, username, role FROM users WHERE id = ?", (user_id,)).fetchone()
        except sqlite3.IntegrityError:
            conn.rollback()
            raise ApiError("Email ini sudah terdaftar. Coba masuk saja.", 409)
        finally:
            conn.close()
        csrf = self.rotate_session(user_id)
        self.send_json({"user": public_user(row), "csrfToken": csrf}, 201)

    def handle_login(self):
        data = self.read_json()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        conn = connect_db()
        try:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        finally:
            conn.close()
        if not row or not password_matches(password, row["password_hash"]):
            raise ApiError("Email atau kata sandi belum cocok.", 401)
        csrf = self.rotate_session(row["id"])
        self.send_json({"user": public_user(row), "csrfToken": csrf})

    def handle_logout(self):
        sess, _user = self.require_session_and_csrf()
        conn = connect_db()
        try:
            conn.execute("DELETE FROM sessions WHERE token = ?", (sess["token"],))
            conn.commit()
        finally:
            conn.close()
        self.request_session = None
        secure = "; Secure" if os.environ.get("COOKIE_SECURE", "0") == "1" else ""
        self.cookie_to_set = f"ll_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax{secure}"
        self.send_json({"ok": True})

    def handle_create_listing(self):
        _sess, user = self.require_session_and_csrf()
        if user["role"] == "buyer":
            raise ApiError("Akun ini disetel sebagai pembeli. Gunakan akun penjual atau pembeli + penjual untuk memasang barang.", 403)
        fields = self.read_multipart()
        title = str(fields.get("title", "")).strip()
        description = str(fields.get("description", "")).strip()
        category = str(fields.get("category", "")).strip()
        size = str(fields.get("size", "")).strip()
        condition = str(fields.get("condition", "")).strip()
        try:
            price = int(fields.get("price", "0"))
        except (TypeError, ValueError):
            raise ApiError("Harga harus berupa angka.")
        if not 4 <= len(title) <= 90:
            raise ApiError("Nama barang harus terdiri dari 4–90 karakter.")
        if not 10 <= len(description) <= 1000:
            raise ApiError("Deskripsi harus terdiri dari 10–1.000 karakter.")
        if not 1000 <= price <= 100_000_000:
            raise ApiError("Harga harus di antara Rp1.000 dan Rp100.000.000.")
        if category not in CATEGORIES or size not in SIZES or condition not in CONDITIONS:
            raise ApiError("Periksa kembali kategori, ukuran, dan kondisi barang.")
        image_file = fields.get("image")
        if isinstance(image_file, dict) and image_file.get("filename") and image_file.get("data"):
            filename_given = Path(image_file["filename"].replace("\\", "/")).name
            ext = filename_given.rsplit(".", 1)[-1].lower() if "." in filename_given else ""
            if ext not in ALLOWED_IMAGE_EXTENSIONS:
                raise ApiError("Format gambar yang didukung: JPG, PNG, WEBP, atau GIF.")
            image_bytes = image_file["data"]
            if len(image_bytes) > MAX_IMAGE_BYTES:
                raise ApiError("Ukuran gambar maksimal 5 MB.", 413)
            filename = f"{uuid.uuid4().hex}.{ext}"
            (UPLOAD_DIR / filename).write_bytes(image_bytes)
            image = f"/uploads/{filename}"
        else:
            image = {
                "Atasan": "/static/assets/baby-tee.svg", "Outerwear": "/static/assets/knit-vest.svg",
                "Bawahan": "/static/assets/denim-jeans.svg", "Dress": "/static/assets/floral-dress.svg",
                "Aksesori": "/static/assets/tote-bag.svg",
            }[category]
        conn = connect_db()
        try:
            cur = conn.execute(
                """INSERT INTO products (title, description, price, category, size, condition, image, seller_id, seller_name, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)""",
                (title, description, price, category, size, condition, image, user["id"], f"@{user['username']}", utc_now()),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
            self.send_json({"product": product_json(row)}, 201)
        finally:
            conn.close()

    def handle_create_order(self):
        sess, user = self.require_session_and_csrf()
        data = self.read_json()
        buyer_name = str(data.get("buyerName", "")).strip()
        phone = str(data.get("phone", "")).strip()
        address = str(data.get("address", "")).strip()
        raw_ids = data.get("productIds")
        if not 2 <= len(buyer_name) <= 100:
            raise ApiError("Nama penerima harus diisi (2–100 karakter).")
        if not re.fullmatch(r"[0-9+()\-\s]{8,20}", phone):
            raise ApiError("Masukkan nomor telepon yang valid.")
        if not 10 <= len(address) <= 500:
            raise ApiError("Alamat lengkap minimal 10 karakter.")
        if not isinstance(raw_ids, list) or not 1 <= len(raw_ids) <= 20:
            raise ApiError("Keranjang kosong atau terlalu banyak barang.")
        try:
            ids = [int(value) for value in raw_ids]
        except (TypeError, ValueError):
            raise ApiError("Isi keranjang tidak valid.")
        if len(set(ids)) != len(ids):
            raise ApiError("Ada barang duplikat di keranjang. Hapus duplikat lalu coba lagi.")
        conn = connect_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            marks = ",".join("?" for _ in ids)
            products = conn.execute(f"SELECT * FROM products WHERE id IN ({marks})", ids).fetchall()
            if len(products) != len(ids):
                raise ApiError("Beberapa barang tidak ditemukan. Muat ulang katalog.", 404)
            if any(p["status"] != "available" for p in products):
                raise ApiError("Ada barang yang baru saja terjual. Perbarui keranjangmu.", 409)
            if any(p["seller_id"] == user["id"] for p in products):
                raise ApiError("Kamu tidak bisa membeli barang yang kamu jual sendiri.", 400)
            total = sum(p["price"] for p in products)
            cur = conn.execute(
                "INSERT INTO orders (buyer_id, buyer_name, phone, address, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (user["id"], buyer_name, phone, address, total, "Menunggu konfirmasi", utc_now()),
            )
            order_id = cur.lastrowid
            for product in products:
                conn.execute(
                    "INSERT INTO order_items (order_id, product_id, title, price) VALUES (?, ?, ?, ?)",
                    (order_id, product["id"], product["title"], product["price"]),
                )
                conn.execute("UPDATE products SET status = 'sold' WHERE id = ?", (product["id"],))
            conn.commit()
            self.send_json({"order": {"id": order_id, "total": total, "status": "Menunggu konfirmasi", "createdAt": utc_now()}}, 201)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def do_OPTIONS(self):
        self.send_bytes(204, b"", "text/plain; charset=utf-8")


def main():
    initialize_database()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    server = ThreadingHTTPServer((host, port), VestigeHandler)
    print("\nVestige siap dipakai!")
    print(f"Buka http://{host}:{port} di browser.")
    print(f"Database: {DB_PATH}")
    print("Tekan Ctrl+C untuk menghentikan server.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
