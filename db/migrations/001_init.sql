-- BloxStar production schema (PostgreSQL / Neon compatible)
-- The browser NEVER connects to this database. Only the server-side API does.

CREATE TABLE IF NOT EXISTS products (
  id            integer PRIMARY KEY,
  game          text        NOT NULL,
  name          text        NOT NULL,
  price_cents   integer     NOT NULL CHECK (price_cents >= 0),
  tier          text        NOT NULL DEFAULT '',
  category      text        NOT NULL DEFAULT '',
  image         text        NOT NULL DEFAULT '',
  stock         integer     NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active        boolean     NOT NULL DEFAULT true,
  on_sale       boolean     NOT NULL DEFAULT false,
  sale_price_cents integer  NULL CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_game_idx ON products (game);

CREATE TABLE IF NOT EXISTS admin_emails (
  email      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          bigserial PRIMARY KEY,
  email       text        NOT NULL,
  code_hash   text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0,
  consumed_at timestamptz NULL,
  ip          text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_email_idx ON otp_codes (email, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_events (
  id         bigserial PRIMARY KEY,
  bucket     text        NOT NULL,   -- e.g. 'otp_send'
  subject    text        NOT NULL,   -- 'email:x@y' or 'ip:1.2.3.4'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_events_lookup_idx ON rate_events (bucket, subject, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id         bigserial PRIMARY KEY,
  token_hash text        NOT NULL UNIQUE,
  email      text        NOT NULL,
  is_admin   boolean     NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  ip         text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions (email);

CREATE TABLE IF NOT EXISTS orders (
  id             bigserial PRIMARY KEY,
  code           text        NOT NULL UNIQUE,   -- server generated
  intent_id      text        NOT NULL UNIQUE,   -- replay / duplicate protection
  email          text        NOT NULL,
  roblox_user    text        NOT NULL DEFAULT '',
  game           text        NOT NULL DEFAULT '',
  subtotal_cents integer     NOT NULL,
  fee_cents      integer     NOT NULL,
  total_cents    integer     NOT NULL,
  method         text        NOT NULL DEFAULT 'moonpay',
  status         text        NOT NULL DEFAULT 'pending_payment',
  paid           boolean     NOT NULL DEFAULT false,
  paid_at        timestamptz NULL,
  confirmed_by   text        NULL,
  stock_reserved boolean     NOT NULL DEFAULT false,
  cancelled_at   timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id            bigserial PRIMARY KEY,
  order_id      bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    integer NOT NULL REFERENCES products(id),
  name          text    NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  unit_cents    integer NOT NULL CHECK (unit_cents >= 0),
  line_cents    integer NOT NULL CHECK (line_cents >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS email_log (
  id         bigserial PRIMARY KEY,
  to_email   text        NOT NULL,
  kind       text        NOT NULL,
  subject    text        NOT NULL DEFAULT '',
  provider   text        NOT NULL DEFAULT 'resend',
  status     text        NOT NULL,
  provider_id text       NULL,
  error      text        NULL,
  dedupe_key text        NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_log_dedupe_idx ON email_log (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id         bigserial PRIMARY KEY,
  email      text        NOT NULL,
  items      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  total_cents integer    NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_events (
  id         bigserial PRIMARY KEY,
  order_id   bigint      NULL REFERENCES orders(id) ON DELETE CASCADE,
  event      text        NOT NULL,
  actor      text        NOT NULL DEFAULT '',
  ip         text        NOT NULL DEFAULT '',
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, created_at DESC);
