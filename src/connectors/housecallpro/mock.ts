// Realistic fake Housecall Pro data used when HCP_MOCK=true.
// Shapes follow the Housecall Pro public API (money in cents, ISO timestamps).

export const mockCustomers = [
  {
    id: 'cus_4f8a2c1e9b7d4a63',
    first_name: 'Sarah',
    last_name: 'Mitchell',
    email: 'sarah.mitchell@example.com',
    mobile_number: '5125550142',
    home_number: null,
    work_number: null,
    company: null,
    notifications_enabled: true,
    lead_source: 'Google',
    tags: ['residential', 'repeat'],
    addresses: [
      { id: 'adr_91c2', type: 'service', street: '1408 Barton Hills Dr', street_line_2: null, city: 'Austin', state: 'TX', zip: '78704', country: 'US' },
    ],
    created_at: '2025-03-11T15:22:04Z',
  },
  {
    id: 'cus_7b3e0d5a2f1c4e88',
    first_name: 'David',
    last_name: 'Ramirez',
    email: 'd.ramirez@ramirezproperties.com',
    mobile_number: '5125550199',
    home_number: null,
    work_number: '5125550100',
    company: 'Ramirez Properties LLC',
    notifications_enabled: true,
    lead_source: 'Referral',
    tags: ['commercial', 'property-manager'],
    addresses: [
      { id: 'adr_44fa', type: 'service', street: '2200 S Lamar Blvd', street_line_2: 'Unit 4', city: 'Austin', state: 'TX', zip: '78704', country: 'US' },
      { id: 'adr_44fb', type: 'billing', street: '500 W 2nd St', street_line_2: 'Suite 1900', city: 'Austin', state: 'TX', zip: '78701', country: 'US' },
    ],
    created_at: '2024-11-02T09:10:40Z',
  },
  {
    id: 'cus_a19c6f3b8e2d4b17',
    first_name: 'Emily',
    last_name: 'Chen',
    email: 'emily.chen@example.com',
    mobile_number: '7375550173',
    home_number: null,
    work_number: null,
    company: null,
    notifications_enabled: false,
    lead_source: 'Yelp',
    tags: ['residential'],
    addresses: [
      { id: 'adr_7d10', type: 'service', street: '9805 Great Hills Trl', street_line_2: null, city: 'Austin', state: 'TX', zip: '78759', country: 'US' },
    ],
    created_at: '2026-01-19T18:45:12Z',
  },
];

type MockCustomer = (typeof mockCustomers)[number];
const customerRef = (c: MockCustomer) => ({
  id: c.id,
  first_name: c.first_name,
  last_name: c.last_name,
  email: c.email,
  mobile_number: c.mobile_number,
});

export const mockJobs = [
  {
    id: 'job_3e7f1a9c5b2d4f60',
    invoice_number: '10482',
    description: 'AC not cooling - diagnose and repair 3-ton Carrier condenser',
    customer: customerRef(mockCustomers[0]!),
    address: mockCustomers[0]!.addresses[0],
    notes: [{ id: 'nte_01', content: 'Customer has a dog in the backyard. Gate code 4412.' }],
    work_status: 'in progress',
    work_timestamps: { on_my_way_at: '2026-10-13T14:05:00Z', started_at: '2026-10-13T14:32:00Z', completed_at: null },
    schedule: { scheduled_start: '2026-10-13T14:00:00Z', scheduled_end: '2026-10-13T16:00:00Z', arrival_window: 60 },
    total_amount: 48500,
    outstanding_balance: 48500,
    assigned_employees: [{ id: 'pro_11a', first_name: 'Marcus', last_name: 'Lee' }],
    tags: ['hvac', 'repair'],
    created_at: '2026-10-12T16:20:00Z',
    updated_at: '2026-10-13T14:32:00Z',
  },
  {
    id: 'job_8c2b6e4d1a9f4c35',
    invoice_number: '10471',
    description: 'Quarterly HVAC maintenance - 4 rooftop units',
    customer: customerRef(mockCustomers[1]!),
    address: mockCustomers[1]!.addresses[0],
    notes: [{ id: 'nte_02', content: 'Check in with building manager at front desk.' }],
    work_status: 'scheduled',
    work_timestamps: { on_my_way_at: null, started_at: null, completed_at: null },
    schedule: { scheduled_start: '2026-10-16T13:00:00Z', scheduled_end: '2026-10-16T18:00:00Z', arrival_window: 0 },
    total_amount: 120000,
    outstanding_balance: 120000,
    assigned_employees: [
      { id: 'pro_11a', first_name: 'Marcus', last_name: 'Lee' },
      { id: 'pro_12b', first_name: 'Priya', last_name: 'Nair' },
    ],
    tags: ['hvac', 'maintenance', 'commercial'],
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z',
  },
  {
    id: 'job_f51d0c7a3e8b4d92',
    invoice_number: '10455',
    description: 'Replace water heater - 50 gal gas',
    customer: customerRef(mockCustomers[2]!),
    address: mockCustomers[2]!.addresses[0],
    notes: [],
    work_status: 'complete unrated',
    work_timestamps: { on_my_way_at: '2026-10-08T15:00:00Z', started_at: '2026-10-08T15:25:00Z', completed_at: '2026-10-08T19:10:00Z' },
    schedule: { scheduled_start: '2026-10-08T15:00:00Z', scheduled_end: '2026-10-08T19:00:00Z', arrival_window: 30 },
    total_amount: 215000,
    outstanding_balance: 215000,
    assigned_employees: [{ id: 'pro_13c', first_name: 'Tom', last_name: 'Becker' }],
    tags: ['plumbing', 'install'],
    created_at: '2026-10-05T12:00:00Z',
    updated_at: '2026-10-08T19:10:00Z',
  },
];

export const mockEstimates = [
  {
    id: 'est_2a6c9e1f4b8d4e07',
    estimate_number: '5021',
    work_status: 'scheduled',
    customer: customerRef(mockCustomers[2]!),
    address: mockCustomers[2]!.addresses[0],
    schedule: { scheduled_start: '2026-10-15T16:00:00Z', scheduled_end: '2026-10-15T17:00:00Z', arrival_window: 0 },
    assigned_employees: [{ id: 'pro_12b', first_name: 'Priya', last_name: 'Nair' }],
    options: [
      { id: 'opt_a1', name: 'Good - Repair existing unit', option_number: '5021-1', total_amount: 89000, approval_status: null, status: 'open' },
      { id: 'opt_a2', name: 'Better - New 3-ton 16 SEER2 system', option_number: '5021-2', total_amount: 785000, approval_status: null, status: 'open' },
    ],
    created_at: '2026-10-10T13:00:00Z',
    updated_at: '2026-10-10T13:00:00Z',
  },
  {
    id: 'est_6d1b3f8a0c2e4a59',
    estimate_number: '5014',
    work_status: 'complete unrated',
    customer: customerRef(mockCustomers[1]!),
    address: mockCustomers[1]!.addresses[0],
    schedule: { scheduled_start: '2026-09-28T15:00:00Z', scheduled_end: '2026-09-28T16:00:00Z', arrival_window: 0 },
    assigned_employees: [{ id: 'pro_11a', first_name: 'Marcus', last_name: 'Lee' }],
    options: [
      { id: 'opt_b1', name: 'Annual maintenance agreement - 4 RTUs', option_number: '5014-1', total_amount: 480000, approval_status: 'approved', status: 'won' },
    ],
    created_at: '2026-09-25T10:30:00Z',
    updated_at: '2026-09-29T09:00:00Z',
  },
];

export const mockInvoices = [
  {
    id: 'inv_7f2d', job_id: mockJobs[2]!.id, customer_id: mockCustomers[2]!.id, invoice_number: '10455', status: 'open',
    amount: 215000, subtotal: 199000, due_amount: 215000, due_at: '2026-10-22T00:00:00Z', paid_at: null,
    sent_at: '2026-10-08T19:30:00Z', service_date: '2026-10-08', invoice_date: '2026-10-08',
  },
  {
    id: 'inv_3b9a', job_id: 'job_0a4e8c2b6d1f4b73', customer_id: mockCustomers[1]!.id, invoice_number: '10398', status: 'pending_payment',
    amount: 96000, subtotal: 96000, due_amount: 46000, due_at: '2026-09-30T00:00:00Z', paid_at: null,
    sent_at: '2026-09-16T14:00:00Z', service_date: '2026-09-15', invoice_date: '2026-09-16',
  },
  {
    id: 'inv_9c1e', job_id: 'job_5b7d9f1a3c8e4d26', customer_id: mockCustomers[0]!.id, invoice_number: '10377', status: 'paid',
    amount: 32500, subtotal: 30000, due_amount: 0, due_at: '2026-09-12T00:00:00Z', paid_at: '2026-09-05T18:22:00Z',
    sent_at: '2026-09-04T20:00:00Z', service_date: '2026-09-04', invoice_date: '2026-09-04',
  },
];
