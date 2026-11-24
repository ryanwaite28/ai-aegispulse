-- Reserved platform tenant (FR-TEN-09): hosts PLATFORM_ADMIN users only; never created, suspended or deactivated via the API.
INSERT INTO registry.tenants (id, slug, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'platform', 'Platform')
ON CONFLICT (id) DO NOTHING;
