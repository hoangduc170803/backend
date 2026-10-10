--
-- WES database schema (generated — do not hand-edit).
--
-- Regenerated from the live database aligned to the TypeORM entities, through
-- migration 1795 (AlignSchemaWithCargoEntities). Supersedes the older
-- hand-written schema, which had drifted from the code (operation_maps vs
-- map_records, a stale transport_request_status_enum, missing cargos/agvs cols).
--
-- Bootstrap a fresh database:
--     createdb wes
--     psql -d wes -f database/schema.sql
--
-- The `migrations` ledger is pre-seeded below, so `pnpm migration:run` is a
-- no-op until genuinely new migrations are added.
--
-- To regenerate after adding migrations: apply them to a scratch DB, then
--     pg_dump --schema-only --no-owner --no-privileges  (+ migrations table data)
--

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg13+1)
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: agv_state_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.agv_state_enum AS ENUM (
    'IDLE',
    'EXECUTING',
    'CHARGING',
    'ERROR',
    'OFFLINE',
    'UNAVAILABLE'
);


--
-- Name: audit_action_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_action_enum AS ENUM (
    'CREATE',
    'UPDATE',
    'DELETE'
);


--
-- Name: audit_entity_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_entity_type_enum AS ENUM (
    'AGV',
    'POINT',
    'PATH',
    'LOCATION',
    'BLOCK',
    'CARGO',
    'TRANSPORT_REQUEST',
    'DISPATCH_POLICY',
    'USER'
);


--
-- Name: block_member_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.block_member_type_enum AS ENUM (
    'POINT',
    'PATH'
);


--
-- Name: block_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.block_type_enum AS ENUM (
    'SINGLE_VEHICLE',
    'SAME_DIRECTION_ONLY',
    'LOCKED'
);


--
-- Name: cargo_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cargo_status_enum AS ENUM (
    'ACTIVE',
    'DELIVERED',
    'CANCELLED'
);


--
-- Name: event_module_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_module_enum AS ENUM (
    'AGV',
    'MAP',
    'TRANSPORT',
    'DISPATCH',
    'AUTH',
    'SYSTEM'
);


--
-- Name: event_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_type_enum AS ENUM (
    'INFO',
    'WARNING',
    'ERROR'
);


--
-- Name: location_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.location_type_enum AS ENUM (
    'PICKUP',
    'DROPOFF',
    'CHARGE'
);


--
-- Name: map_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.map_status_enum AS ENUM (
    'DRAFT',
    'ACTIVE',
    'ARCHIVED'
);


--
-- Name: point_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.point_type_enum AS ENUM (
    'HALT',
    'PARK'
);


--
-- Name: transport_request_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transport_request_status_enum AS ENUM (
    'CREATED',
    'READY_TO_ASSIGN',
    'BLOCKED',
    'PICKING_UP',
    'DELIVERING',
    'DELIVERY_COMPLETED',
    'CANCELLED',
    'FAILED'
);


--
-- Name: user_role_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role_enum AS ENUM (
    'ADMIN',
    'OPERATOR'
);


--
-- Name: zone_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.zone_status_enum AS ENUM (
    'ACTIVE',
    'STALE'
);


--
-- Name: zone_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.zone_type_enum AS ENUM (
    'PICKUP',
    'DROPOFF'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agv_error_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agv_error_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agv_id uuid NOT NULL,
    error_code character varying(50) NOT NULL,
    error_message text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: agv_live_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agv_live_status (
    agv_id uuid NOT NULL,
    state public.agv_state_enum DEFAULT 'OFFLINE'::public.agv_state_enum NOT NULL,
    current_point character varying(100),
    battery_level smallint,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agv_live_status_battery_level_check CHECK (((battery_level >= 0) AND (battery_level <= 100)))
);


--
-- Name: agv_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agv_status_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agv_id uuid NOT NULL,
    state public.agv_state_enum NOT NULL,
    current_point character varying(100),
    battery_level smallint,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agvs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agvs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(100) NOT NULL,
    mac_address character varying(17),
    is_dispatch_enabled boolean DEFAULT true NOT NULL,
    is_ignored boolean DEFAULT false NOT NULL,
    operational_battery_threshold smallint DEFAULT 20 NOT NULL,
    charging_battery_threshold smallint DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model character varying(255),
    manufacturer character varying(255),
    serial_number character varying(255),
    initial_position character varying(100),
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_id uuid,
    CONSTRAINT agvs_charging_battery_threshold_check CHECK (((charging_battery_threshold >= 0) AND (charging_battery_threshold <= 100))),
    CONSTRAINT agvs_operational_battery_threshold_check CHECK (((operational_battery_threshold >= 0) AND (operational_battery_threshold <= 100)))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    entity_type public.audit_entity_type_enum NOT NULL,
    entity_id uuid NOT NULL,
    action public.audit_action_enum NOT NULL,
    old_value jsonb,
    new_value jsonb,
    performed_by uuid,
    performed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: block_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_members (
    block_id uuid NOT NULL,
    member_id uuid NOT NULL,
    member_type public.block_member_type_enum NOT NULL
);


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    map_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    type public.block_type_enum DEFAULT 'SINGLE_VEHICLE'::public.block_type_enum NOT NULL,
    max_vehicle_count smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cargos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cargos (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    item_code character varying(255) NOT NULL,
    source_point_id uuid,
    destination_location_id uuid,
    status public.cargo_status_enum DEFAULT 'ACTIVE'::public.cargo_status_enum NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_zone_id uuid,
    destination_zone_id uuid,
    source_point_name character varying(255),
    source_pickup_location_name character varying(255),
    destination_location_name character varying(255),
    deleted_at timestamp with time zone
);


--
-- Name: dispatch_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_policies (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    weight_urgency double precision DEFAULT 1.0 NOT NULL,
    weight_proximity double precision DEFAULT 1.0 NOT NULL,
    weight_inventory_position double precision DEFAULT 1.0 NOT NULL,
    weight_battery double precision DEFAULT 0 NOT NULL,
    max_agv_per_block smallint DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    event_type public.event_type_enum DEFAULT 'INFO'::public.event_type_enum NOT NULL,
    module public.event_module_enum NOT NULL,
    entity_type character varying(50),
    entity_id uuid,
    correlation_id uuid,
    message text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: kpi_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kpi_snapshots (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    total_requests integer DEFAULT 0 NOT NULL,
    completed_requests integer DEFAULT 0 NOT NULL,
    failed_requests integer DEFAULT 0 NOT NULL,
    cancelled_requests integer DEFAULT 0 NOT NULL,
    avg_assign_time_seconds double precision,
    avg_completion_time_seconds double precision,
    active_agv_count smallint DEFAULT 0 NOT NULL,
    throughput_per_hour double precision
);


--
-- Name: location_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.location_points (
    location_id uuid NOT NULL,
    point_id uuid NOT NULL,
    position_index smallint DEFAULT 0 NOT NULL
);


--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    map_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    type public.location_type_enum NOT NULL,
    approach_direction character varying(20),
    is_available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: map_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    original_filename character varying(255) NOT NULL,
    point_count integer DEFAULT 0 NOT NULL,
    path_count integer DEFAULT 0 NOT NULL,
    vehicle_count integer DEFAULT 0 NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    uploaded_by_id uuid
);


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: operation_maps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_maps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    version character varying(20) NOT NULL,
    status public.map_status_enum DEFAULT 'DRAFT'::public.map_status_enum NOT NULL,
    file_path text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: paths; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paths (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    map_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    source_point_id uuid NOT NULL,
    dest_point_id uuid NOT NULL,
    max_velocity integer DEFAULT 0 NOT NULL,
    max_reverse_velocity integer DEFAULT 0 NOT NULL,
    length double precision,
    is_available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT paths_check CHECK ((source_point_id <> dest_point_id)),
    CONSTRAINT paths_max_reverse_velocity_check CHECK ((max_reverse_velocity >= 0)),
    CONSTRAINT paths_max_velocity_check CHECK ((max_velocity >= 0))
);


--
-- Name: points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    map_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    x_coord double precision NOT NULL,
    y_coord double precision NOT NULL,
    type public.point_type_enum DEFAULT 'HALT'::public.point_type_enum NOT NULL,
    is_available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    is_revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id smallint NOT NULL,
    name public.user_role_enum NOT NULL,
    description text
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    AS smallint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id bigint NOT NULL,
    label character varying(100) NOT NULL,
    notes text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sse_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sse_sessions (
    id bigint NOT NULL,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason character varying(100)
);


--
-- Name: sse_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sse_sessions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sse_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: task_status_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_status_transitions (
    id bigint NOT NULL,
    task_id uuid NOT NULL,
    from_status character varying(30),
    to_status character varying(30) NOT NULL,
    trigger character varying(30),
    vehicle_name character varying(50),
    reason text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_status_transitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.task_status_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.task_status_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transport_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    request_code character varying(50) NOT NULL,
    cargo_id uuid,
    source_point_id uuid,
    destination_location_id uuid,
    pickup_point_id uuid,
    dropoff_point_id uuid,
    assigned_agv_id uuid,
    status public.transport_request_status_enum DEFAULT 'CREATED'::public.transport_request_status_enum NOT NULL,
    invalid_reason text,
    no_pickup_reason text,
    no_dropoff_reason text,
    no_assign_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    language character varying(5) DEFAULT 'vi'::character varying NOT NULL,
    notifications_enabled boolean DEFAULT true NOT NULL,
    sound_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id smallint NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    ip_address inet,
    user_agent text,
    login_at timestamp with time zone DEFAULT now() NOT NULL,
    logout_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(100) NOT NULL,
    phone character varying(30),
    shift character varying(100),
    avatar_url text,
    is_active boolean DEFAULT true NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    is_invited boolean DEFAULT false NOT NULL,
    lock_reason text,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vehicle_state_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_state_transitions (
    id bigint NOT NULL,
    session_id bigint NOT NULL,
    vehicle_name character varying(50) NOT NULL,
    point_name character varying(50),
    proc_state character varying(30),
    vehicle_state character varying(30),
    order_name character varying(80),
    goal_order_name character varying(80),
    order_created_at timestamp with time zone,
    goal_received_at timestamp with time zone,
    occurred_at timestamp with time zone NOT NULL,
    observed_at timestamp with time zone
);


--
-- Name: vehicle_state_transitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.vehicle_state_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.vehicle_state_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: zone_kernel_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.zone_kernel_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: zone_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zone_members (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    zone_id uuid NOT NULL,
    location_name character varying(255) NOT NULL,
    position_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zones (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    type public.zone_type_enum NOT NULL,
    color character varying(9),
    kernel_id integer,
    approach_location_name character varying(255),
    status public.zone_status_enum DEFAULT 'ACTIVE'::public.zone_status_enum NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: migrations PK_8c82d7f526340ab734260ea46be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);


--
-- Name: agv_error_history agv_error_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_error_history
    ADD CONSTRAINT agv_error_history_pkey PRIMARY KEY (id);


--
-- Name: agv_live_status agv_live_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_live_status
    ADD CONSTRAINT agv_live_status_pkey PRIMARY KEY (agv_id);


--
-- Name: agv_status_history agv_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_status_history
    ADD CONSTRAINT agv_status_history_pkey PRIMARY KEY (id);


--
-- Name: agvs agvs_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agvs
    ADD CONSTRAINT agvs_code_key UNIQUE (code);


--
-- Name: agvs agvs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agvs
    ADD CONSTRAINT agvs_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: block_members block_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_members
    ADD CONSTRAINT block_members_pkey PRIMARY KEY (block_id, member_id);


--
-- Name: blocks blocks_map_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_map_id_name_key UNIQUE (map_id, name);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);


--
-- Name: cargos cargos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargos
    ADD CONSTRAINT cargos_pkey PRIMARY KEY (id);


--
-- Name: dispatch_policies dispatch_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_policies
    ADD CONSTRAINT dispatch_policies_pkey PRIMARY KEY (id);


--
-- Name: event_logs event_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_logs
    ADD CONSTRAINT event_logs_pkey PRIMARY KEY (id);


--
-- Name: kpi_snapshots kpi_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kpi_snapshots
    ADD CONSTRAINT kpi_snapshots_pkey PRIMARY KEY (id);


--
-- Name: location_points location_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.location_points
    ADD CONSTRAINT location_points_pkey PRIMARY KEY (location_id, point_id);


--
-- Name: locations locations_map_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_map_id_name_key UNIQUE (map_id, name);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: map_records map_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_records
    ADD CONSTRAINT map_records_pkey PRIMARY KEY (id);


--
-- Name: operation_maps operation_maps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_maps
    ADD CONSTRAINT operation_maps_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: paths paths_map_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_map_id_name_key UNIQUE (map_id, name);


--
-- Name: paths paths_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_pkey PRIMARY KEY (id);


--
-- Name: points points_map_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points
    ADD CONSTRAINT points_map_id_name_key UNIQUE (map_id, name);


--
-- Name: points points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points
    ADD CONSTRAINT points_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: sse_sessions sse_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sse_sessions
    ADD CONSTRAINT sse_sessions_pkey PRIMARY KEY (id);


--
-- Name: task_status_transitions task_status_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_status_transitions
    ADD CONSTRAINT task_status_transitions_pkey PRIMARY KEY (id);


--
-- Name: transport_requests transport_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_pkey PRIMARY KEY (id);


--
-- Name: transport_requests transport_requests_request_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_request_code_key UNIQUE (request_code);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: vehicle_state_transitions vehicle_state_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_state_transitions
    ADD CONSTRAINT vehicle_state_transitions_pkey PRIMARY KEY (id);


--
-- Name: zone_members zone_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zone_members
    ADD CONSTRAINT zone_members_pkey PRIMARY KEY (id);


--
-- Name: zones zones_kernel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_kernel_id_key UNIQUE (kernel_id);


--
-- Name: zones zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT zones_pkey PRIMARY KEY (id);


--
-- Name: idx_agv_error_history_agv_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agv_error_history_agv_id ON public.agv_error_history USING btree (agv_id);


--
-- Name: idx_agv_error_history_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agv_error_history_occurred_at ON public.agv_error_history USING btree (occurred_at DESC);


--
-- Name: idx_agv_status_history_agv_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agv_status_history_agv_id ON public.agv_status_history USING btree (agv_id);


--
-- Name: idx_agv_status_history_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agv_status_history_recorded_at ON public.agv_status_history USING btree (recorded_at DESC);


--
-- Name: idx_audit_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: idx_audit_logs_performed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_performed_at ON public.audit_logs USING btree (performed_at DESC);


--
-- Name: idx_audit_logs_performed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_performed_by ON public.audit_logs USING btree (performed_by);


--
-- Name: idx_blocks_map_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blocks_map_id ON public.blocks USING btree (map_id);


--
-- Name: idx_cargos_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cargos_created_at ON public.cargos USING btree (created_at DESC);


--
-- Name: idx_cargos_destination; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cargos_destination ON public.cargos USING btree (destination_location_id);


--
-- Name: idx_cargos_destination_zone_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cargos_destination_zone_id ON public.cargos USING btree (destination_zone_id);


--
-- Name: idx_cargos_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cargos_source ON public.cargos USING btree (source_point_id);


--
-- Name: idx_cargos_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cargos_status ON public.cargos USING btree (status);


--
-- Name: idx_event_logs_correlation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_logs_correlation_id ON public.event_logs USING btree (correlation_id) WHERE (correlation_id IS NOT NULL);


--
-- Name: idx_event_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_logs_created_at ON public.event_logs USING btree (created_at DESC);


--
-- Name: idx_event_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_logs_entity ON public.event_logs USING btree (entity_type, entity_id);


--
-- Name: idx_event_logs_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_logs_module ON public.event_logs USING btree (module);


--
-- Name: idx_kpi_snapshots_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kpi_snapshots_at ON public.kpi_snapshots USING btree (snapshot_at DESC);


--
-- Name: idx_locations_map_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_locations_map_id ON public.locations USING btree (map_id);


--
-- Name: idx_password_reset_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_expires_at ON public.password_reset_tokens USING btree (expires_at);


--
-- Name: idx_password_reset_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_paths_dest_point; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_dest_point ON public.paths USING btree (dest_point_id);


--
-- Name: idx_paths_map_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_map_id ON public.paths USING btree (map_id);


--
-- Name: idx_paths_source_point; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_paths_source_point ON public.paths USING btree (source_point_id);


--
-- Name: idx_points_map_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_points_map_id ON public.points USING btree (map_id);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_transport_requests_assigned_agv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_requests_assigned_agv ON public.transport_requests USING btree (assigned_agv_id);


--
-- Name: idx_transport_requests_cargo_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_requests_cargo_id ON public.transport_requests USING btree (cargo_id);


--
-- Name: idx_transport_requests_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_requests_created_at ON public.transport_requests USING btree (created_at DESC);


--
-- Name: idx_transport_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_requests_status ON public.transport_requests USING btree (status);


--
-- Name: idx_tst_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tst_task ON public.task_status_transitions USING btree (task_id, occurred_at);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_vst_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vst_vehicle ON public.vehicle_state_transitions USING btree (vehicle_name, occurred_at);


--
-- Name: idx_zone_members_zone_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zone_members_zone_id ON public.zone_members USING btree (zone_id);


--
-- Name: idx_zones_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zones_deleted_at ON public.zones USING btree (deleted_at);


--
-- Name: ux_dispatch_policies_single_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_dispatch_policies_single_active ON public.dispatch_policies USING btree (is_active) WHERE (is_active = true);


--
-- Name: agv_error_history agv_error_history_agv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_error_history
    ADD CONSTRAINT agv_error_history_agv_id_fkey FOREIGN KEY (agv_id) REFERENCES public.agvs(id) ON DELETE CASCADE;


--
-- Name: agv_live_status agv_live_status_agv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_live_status
    ADD CONSTRAINT agv_live_status_agv_id_fkey FOREIGN KEY (agv_id) REFERENCES public.agvs(id) ON DELETE CASCADE;


--
-- Name: agv_status_history agv_status_history_agv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agv_status_history
    ADD CONSTRAINT agv_status_history_agv_id_fkey FOREIGN KEY (agv_id) REFERENCES public.agvs(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: block_members block_members_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_members
    ADD CONSTRAINT block_members_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.blocks(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_map_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.operation_maps(id) ON DELETE CASCADE;


--
-- Name: cargos cargos_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargos
    ADD CONSTRAINT cargos_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cargos cargos_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargos
    ADD CONSTRAINT cargos_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: cargos cargos_source_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cargos
    ADD CONSTRAINT cargos_source_point_id_fkey FOREIGN KEY (source_point_id) REFERENCES public.points(id) ON DELETE SET NULL;


--
-- Name: dispatch_policies dispatch_policies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_policies
    ADD CONSTRAINT dispatch_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: event_logs event_logs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_logs
    ADD CONSTRAINT event_logs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: location_points location_points_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.location_points
    ADD CONSTRAINT location_points_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE;


--
-- Name: location_points location_points_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.location_points
    ADD CONSTRAINT location_points_point_id_fkey FOREIGN KEY (point_id) REFERENCES public.points(id) ON DELETE CASCADE;


--
-- Name: locations locations_map_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.operation_maps(id) ON DELETE CASCADE;


--
-- Name: map_records map_records_uploaded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_records
    ADD CONSTRAINT map_records_uploaded_by_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: operation_maps operation_maps_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_maps
    ADD CONSTRAINT operation_maps_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: paths paths_dest_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_dest_point_id_fkey FOREIGN KEY (dest_point_id) REFERENCES public.points(id) ON DELETE CASCADE;


--
-- Name: paths paths_map_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.operation_maps(id) ON DELETE CASCADE;


--
-- Name: paths paths_source_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paths
    ADD CONSTRAINT paths_source_point_id_fkey FOREIGN KEY (source_point_id) REFERENCES public.points(id) ON DELETE CASCADE;


--
-- Name: points points_map_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points
    ADD CONSTRAINT points_map_id_fkey FOREIGN KEY (map_id) REFERENCES public.operation_maps(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: task_status_transitions task_status_transitions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_status_transitions
    ADD CONSTRAINT task_status_transitions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.transport_requests(id);


--
-- Name: transport_requests transport_requests_assigned_agv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_assigned_agv_id_fkey FOREIGN KEY (assigned_agv_id) REFERENCES public.agvs(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_cargo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_cargo_id_fkey FOREIGN KEY (cargo_id) REFERENCES public.cargos(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_destination_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES public.locations(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_dropoff_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_dropoff_point_id_fkey FOREIGN KEY (dropoff_point_id) REFERENCES public.points(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_pickup_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_pickup_point_id_fkey FOREIGN KEY (pickup_point_id) REFERENCES public.points(id) ON DELETE SET NULL;


--
-- Name: transport_requests transport_requests_source_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_requests
    ADD CONSTRAINT transport_requests_source_point_id_fkey FOREIGN KEY (source_point_id) REFERENCES public.points(id) ON DELETE SET NULL;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vehicle_state_transitions vehicle_state_transitions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_state_transitions
    ADD CONSTRAINT vehicle_state_transitions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sse_sessions(id);


--
-- Name: zone_members zone_members_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zone_members
    ADD CONSTRAINT zone_members_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.zones(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- Data for Name: migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.migrations (id, "timestamp", name) FROM stdin;
3	1782639025056	DropMapIsActive1782639025056
4	1750000000000	AddZoneKernelId1750000000000
5	1750942500000	AddZoneSoftDelete1750942500000
6	1790000000000	AddCargoSourceZoneAndBlockedStatus1790000000000
7	1791000000000	AddCargoDestinationZone1791000000000
8	1792000000000	AddInstrumentationTables1792000000000
9	1792000001000	AddObservedAtToVehicleStateTransitions1792000001000
10	1793000000000	AddZoneColor1793000000000
11	1794000000000	AddTransportRequestMetadata1794000000000
12	1795000000000	AlignSchemaWithCargoEntities1795000000000
\.


--
-- Name: migrations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.migrations_id_seq', 12, true);


--
-- PostgreSQL database dump complete


--
-- RBAC: dynamic roles + permission catalogue + permanent API tokens
-- (mirrors migration 1804000000000-AddRbacPermissions; idempotent).
--

CREATE TABLE IF NOT EXISTS public.permissions (
    key          varchar(64) PRIMARY KEY,
    cluster      varchar(32) NOT NULL,
    is_dangerous boolean NOT NULL DEFAULT false,
    sort         integer NOT NULL DEFAULT 0,
    label_vi     varchar(160),
    label_en     varchar(160),
    label_ja     varchar(160)
);

-- mirrors migration 1832000000000-AddPermissionScreenGrouping
ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS screen varchar(32) NOT NULL DEFAULT 'system';
ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS group_key varchar(48) NOT NULL DEFAULT 'actions';
ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'action';
ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS parent_key varchar(64);

ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS key varchar(48);
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.roles ALTER COLUMN name TYPE varchar(64) USING name::text;
UPDATE public.roles SET key = lower(name) WHERE key IS NULL;
UPDATE public.roles SET is_system = true WHERE key IN ('admin', 'operator', 'viewer');
UPDATE public.roles SET name = 'Quản trị viên' WHERE key = 'admin';
UPDATE public.roles SET name = 'Điều hành viên' WHERE key = 'operator';
CREATE UNIQUE INDEX IF NOT EXISTS roles_key_uq ON public.roles (key);

INSERT INTO public.roles (name, key, description, is_system)
VALUES ('Người xem', 'viewer', 'Chỉ xem, không thao tác vận hành', true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id        smallint NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
    permission_key varchar(64) NOT NULL REFERENCES public.permissions (key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS public.api_tokens (
    id           uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id      uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    jti          uuid NOT NULL UNIQUE,
    label        varchar(120),
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON public.api_tokens (user_id);

--
-- Forced password change (mirrors migration 1805000000000-AddMustChangePassword; idempotent).
--
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

--
-- Force re-login after a password change (mirrors migration 1806000000000-AddPasswordChangedAt).
--
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();

--
-- Pasted (opaque, non-JWT) permanent tokens (mirrors migration 1807000000000-AddApiTokenHash).
--
ALTER TABLE public.api_tokens ALTER COLUMN jti DROP NOT NULL;
ALTER TABLE public.api_tokens ADD COLUMN IF NOT EXISTS token_hash varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_uq ON public.api_tokens (token_hash) WHERE token_hash IS NOT NULL;
