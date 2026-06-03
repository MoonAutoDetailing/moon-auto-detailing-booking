alter table public.customers
alter column address drop not null;

update public.customers
set address = null
where address is not null
  and lower(trim(address)) in ('n/a','na','none','no address','unknown','null','nil','-','address not provided');
