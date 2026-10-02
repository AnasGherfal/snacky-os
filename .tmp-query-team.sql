select id, full_name, email, role, roles, active, active_status, auth_user_id, must_change_password
from public.team_members
where email in ('anas@snacky.local','test@snacky.local')
order by email;
