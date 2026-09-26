export const indiaDay = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

// Group by the actual deadline, never by creation date or a silently moved date.
export function workGroup(item, today = indiaDay()) {
  if (['resolved','closed','approved'].includes(item.status)) return 'closed';
  if (item.status === 'submitted') return 'approval';
  const due = String(item.deadline_date || item.target_date || item.due_date || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 'undated';
  return due < today ? 'previous' : due === today ? 'today' : 'upcoming';
}
export const workGroups = [['today',"Today's Pending Tasks"],['previous','Previous Pending Tasks'],['approval','Awaiting Approval'],['upcoming','Upcoming Tasks'],['undated','No Due Date'],['closed','Completed / Closed']];
