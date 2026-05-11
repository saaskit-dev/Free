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
