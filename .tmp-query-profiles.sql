select id, full_name, email, role, roles, active_status, team_member_id, must_change_password
from public.profiles
where email in ('anas@snacky.local','test@snacky.local')
order by email;
