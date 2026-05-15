create table if not exists acp_accounts (
  account_id text primary key,
  disabled integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists acp_client_devices (
  account_id text not null,
  client_device_id text not null,
  public_key text not null,
  disabled integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (account_id, client_device_id),
  foreign key (account_id) references acp_accounts(account_id)
);

create table if not exists acp_hosts (
  account_id text not null,
  host_id text not null,
  public_key text not null,
  previous_public_key text,
  metadata_json text,
  last_connected_at text,
  last_disconnected_at text,
  disabled integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (account_id, host_id),
  foreign key (account_id) references acp_accounts(account_id)
);

create table if not exists acp_grants (
  grant_id text primary key,
  account_id text not null,
  client_device_id text,
  host_id text not null,
  workspace_id text,
  workspace_roots_json text,
  policy_version integer not null,
  scopes_json text not null,
  revoked integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  foreign key (account_id) references acp_accounts(account_id),
  foreign key (account_id, client_device_id)
    references acp_client_devices(account_id, client_device_id),
  foreign key (account_id, host_id) references acp_hosts(account_id, host_id)
);

create index if not exists acp_grants_authorization_idx
  on acp_grants(account_id, client_device_id, host_id, revoked);

create index if not exists acp_grants_account_wide_idx
  on acp_grants(account_id, host_id, revoked)
  where client_device_id is null;

create table if not exists acp_github_accounts (
  github_id integer primary key,
  github_login text not null,
  account_id text not null,
  created_at integer not null,
  foreign key (account_id) references acp_accounts(account_id)
);

create table if not exists acp_oauth_states (
  state text primary key,
  return_to text not null,
  created_at integer not null
);

create index if not exists acp_oauth_states_expiry_idx
  on acp_oauth_states(created_at);

create table if not exists acp_remote_session_bindings (
  account_id text not null,
  client_device_id text not null,
  session_id text not null,
  host_id text not null,
  agent_json text,
  workspace_roots_json text,
  title text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  primary key (account_id, client_device_id, session_id),
  foreign key (account_id) references acp_accounts(account_id),
  foreign key (account_id, client_device_id)
    references acp_client_devices(account_id, client_device_id),
  foreign key (account_id, host_id) references acp_hosts(account_id, host_id)
);

create index if not exists acp_remote_session_bindings_host_idx
  on acp_remote_session_bindings(account_id, host_id);

create table if not exists acp_login_approvals (
  approval_id text primary key,
  account_id text not null,
  github_login text not null,
  principal_id text not null,
  principal_type text not null,
  principal_public_key text,
  return_to text not null,
  created_at integer not null,
  foreign key (account_id) references acp_accounts(account_id)
);

create index if not exists acp_login_approvals_expiry_idx
  on acp_login_approvals(created_at);
