-- =============================================================================
-- 0005 - profile - collaborative roles with multi-parent inheritance
-- =============================================================================

insert into profile (name, description, inheritance) values
  ('creative', 'Creative collaboration profile - innovative, expressive, imaginative', array['collaboration']),
  ('developer', 'Software development collaboration profile - clean, systematic, maintainable', array['engineer']),
  ('engineer', 'Technical engineering collaboration profile - focused, competent, authentic', array['collaboration']),
  ('humanist', 'Liberal arts and humanistic collaboration profile - thoughtful, analytical, expressive', array['collaboration']),
  ('researcher', 'Academic research collaboration profile - rigorous, methodical, evidence-based', array['collaboration']),
  ('translator', 'Professional translation collaboration profile - precise, culturally aware, systematic', array['collaboration']),
  ('collaboration', 'Shared collaboration context and methodology', array['infrastructure', 'initialization', 'memory', 'monitoring', 'temporal']),
  ('infrastructure', 'Shared infrastructure context and methodology', array[]::text[]),
  ('initialization', 'Framework initialization and operations context', array[]::text[]),
  ('memory', 'Shared memory context and cache operations', array[]::text[]),
  ('monitoring', 'Shared monitoring observations for behavioral diagnostics', array[]::text[]),
  ('temporal', 'Temporal awareness context for framework operations', array[]::text[]);

insert into platform_migrations (version, name) values (5, 'profile');
