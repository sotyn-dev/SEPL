export const STAFF_TYPES = { blue_collar: 'Blue Collar', white_collar: 'White Collar' };
export const staffTypeLabel = value => STAFF_TYPES[value] || 'Not specified';
export const matchesStaffType = (value, filter) => !filter || (filter === 'unspecified' ? !value : value === filter);
