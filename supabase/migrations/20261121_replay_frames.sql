-- Move replay snapshots out of bgio_matches.metadata. The API rewrites match
-- metadata during ordinary player updates; embedding every replay frame there
-- made these writes progressively slower and larger.
create table if not exists public.online_room_replay_frames (
  match_id text not null references public.online_rooms(match_id) on delete cascade,
  frame_id text not null,
  log_start integer not null,
  log_end integer not null,
  player_index integer not null,
  frame jsonb not null,
  created_at timestamptz not null default now(),
  primary key (match_id, frame_id)
);
create index if not exists online_room_replay_frames_order_idx on public.online_room_replay_frames(match_id, log_end, log_start);
alter table public.online_room_replay_frames enable row level security;
revoke all on public.online_room_replay_frames from anon, authenticated;
grant all on public.online_room_replay_frames to service_role;

-- Old embedded replay frames are intentionally discarded. New frames are
-- written as separate rows; this also frees legacy metadata from repeat writes.
update public.bgio_matches
set metadata = metadata - 'publicReplayFrames'
where metadata ? 'publicReplayFrames';
