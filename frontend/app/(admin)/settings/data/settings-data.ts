// app/(admin)/settings/data/settings-data.ts
import type { MaintenanceRole } from '@/lib/maintenance';

// --- Types ---

export type VoucherType = 'FREE_RIDE' | 'DISCOUNT';

export type VoucherStatus = 'Active' | 'Used' | 'Expired';

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  displayOrder: number;
}

export interface Voucher {
  id: string;
  code: string;
  type: string;
  status: VoucherStatus;
}

export interface FinancialRulesConfig {
  ridesForFreeReward: string;
  regularDiscount: string;
  /** One rate shared by Student, Senior Citizen and PWD; prices every discounted fare. */
  discountRate: string;
  /** Fare for trips up to baseBarangayCount barangays. */
  minimumFare: string;
  /** Added per barangay traversed beyond baseBarangayCount. */
  succeedingFare: string;
  /** Barangays the minimum fare covers (both ends of the trip counted). */
  baseBarangayCount: string;
  /** Month (1-12) students renew in; unrenewed discounts end on the 1st of the next month. */
  studentRenewalMonth: string;
}

export interface OperationsRulesConfig {
  speedLimitKmh: string;
  maxShiftHours: string;
  remittanceGraceMinutes: string;
  remittanceReminderIntervalMinutes: string;
}

export interface AppConfiguration {
  maintenanceMode: boolean;
  maintenanceRoles: MaintenanceRole[];
  maintenanceMessage: string;
  requireIdUpload: boolean;
}

export interface SafetyConfig {
  emergencyHotline: string;
}

// Controls the fare receipt auto-printed on the conductor's thermal printer
// after a successful cash/GCash transaction. Text fields customize the
// printout's branding; the toggles decide which transaction details appear.
export interface ReceiptConfig {
  businessName: string;
  addressLine: string;
  footerNote: string;
  paperWidth: '58' | '80'; // mm — standard thermal roll widths
  autoPrint: boolean;
  showDateTime: boolean;
  showTransactionId: boolean;
  showRoute: boolean;
  showUnit: boolean;
  showConductor: boolean;
  showPassenger: boolean;
  showFareBreakdown: boolean;
  showQrCode: boolean;
  showManualCode: boolean;
}

// --- FAQ Data ---

export const initialFaqs: FaqItem[] = [
  { id: '1', question: 'How do I pay with GCash?', answer: 'Simply show your QR code to the conductor when boarding. They scan it and payment is processed instantly via GCash.', displayOrder: 1 },
  { id: '2', question: 'I left my item on the jeep. How do I report it?', answer: 'Go to the "Lost & Found" section in the app menu and fill out the item report form with the details of your trip.', displayOrder: 2 },
];

// --- Notification Templates (Settings > Notifications) ---

export type NotificationAudience = 'Commuter emails' | 'Commuter notifications' | 'Conductor notifications';

export interface TemplateVariable {
  name: string;
  /** Filled into the preview so admins see a realistic message. */
  sample: string;
}

export interface NotificationTemplateDef {
  /** Settings key (category "safety"). */
  key: string;
  audience: NotificationAudience;
  title: string;
  /** When the system sends it. */
  sentWhen: string;
  /** What the system adds around the editable text, if anything. */
  note?: string;
  defaultText: string;
  variables: TemplateVariable[];
}

const NAME: TemplateVariable = { name: 'name', sample: 'Maria Santos' };
const DISCOUNT_TYPE: TemplateVariable = { name: 'discount_type', sample: 'Student' };
const REASON: TemplateVariable = { name: 'reason', sample: 'The ID photo is blurry.' };

// Only the message text is editable; titles and layout stay in code. Defaults
// must match the backend: AdminService::DEFAULT_APPROVED/REJECTED_TEMPLATE for
// the registration emails, App\Support\MessageTemplates::DEFAULTS for the rest.
export const notificationTemplates: NotificationTemplateDef[] = [
  {
    key: 'account_approved_template',
    audience: 'Commuter emails',
    title: 'Account approved',
    sentWhen: 'Sent when an admin approves a commuter registration ID.',
    note: 'The header, account summary, sign-in button and footer are added around this text. Using {commuter_type} here hides the separate fare-type row.',
    defaultText: `Hi {name},\n\nGreat news — we've reviewed the ID you submitted and your CHATCO commuter account is now approved and active.\n\nLog in with the email and password you registered with, and you're ready to ride.`,
    variables: [NAME, { name: 'commuter_type', sample: 'Student' }],
  },
  {
    key: 'account_rejected_template',
    audience: 'Commuter emails',
    title: 'Account rejected',
    sentWhen: 'Sent when an admin rejects a commuter registration ID.',
    note: '{reason} and {next_steps} appear as their own blocks below this text. Put them in the text only to place them inline instead.',
    defaultText: `Hi {name},\n\nThanks for signing up with CHATCO. We've finished reviewing the ID attached to your commuter registration, and unfortunately we weren't able to approve it this time.`,
    variables: [NAME, REASON, { name: 'next_steps', sample: 'Fix what the reason above points to, then sign up again.' }],
  },
  {
    key: 'onsite_account_template',
    audience: 'Commuter emails',
    title: 'Terminal account welcome',
    sentWhen: 'Sent when an admin creates a commuter account at a terminal.',
    note: 'The sign-in details, default password and the change-password notice are always added below this text.',
    defaultText: 'Hi {name}, an admin created your commuter account at a CHATCO terminal. Sign in with the default password below.',
    variables: [NAME, { name: 'email', sample: 'maria.santos@gmail.com' }, { name: 'username', sample: 'mariasantos' }],
  },
  {
    key: 'discount_approved_template',
    audience: 'Commuter notifications',
    title: 'Discount approved',
    sentWhen: 'Sent when an admin approves a Student, Senior Citizen or PWD discount application.',
    defaultText: 'Your {discount_type} discount application is approved. Your commuter classification has been updated.',
    variables: [NAME, DISCOUNT_TYPE],
  },
  {
    key: 'discount_correction_template',
    audience: 'Commuter notifications',
    title: 'Discount needs correction',
    sentWhen: 'Sent when an admin asks for corrected discount documents.',
    defaultText: 'Your discount application needs a correction. Submit corrected supporting documents from your Discount Application page. Your account remains Regular until it is approved. {reason}',
    variables: [NAME, DISCOUNT_TYPE, REASON],
  },
  {
    key: 'discount_rejected_template',
    audience: 'Commuter notifications',
    title: 'Discount rejected',
    sentWhen: 'Sent when an admin rejects a discount application.',
    defaultText: 'Your discount application was not approved. Your account remains Regular. {reason}',
    variables: [NAME, DISCOUNT_TYPE, REASON],
  },
  {
    key: 'renewal_reminder_template',
    audience: 'Commuter notifications',
    title: 'Student renewal reminder',
    sentWhen: 'Sent on a schedule before the yearly student renewal deadline to students who have not renewed.',
    defaultText: 'Renew your student status {period}. Submit a school ID showing the current school year or valid enrollment proof. Your discount continues throughout the renewal period. Without a submission by {deadline}, your commuter type becomes Regular. Open Student Renewal to submit proof or choose No Longer a Student.',
    variables: [NAME, { name: 'period', sample: 'September 1-30, 2027' }, { name: 'deadline', sample: 'October 1' }],
  },
  {
    key: 'renewal_approved_template',
    audience: 'Commuter notifications',
    title: 'Student renewal approved',
    sentWhen: 'Sent when an admin approves a student renewal.',
    defaultText: 'Your student status has been renewed. Your student discount is available.',
    variables: [NAME],
  },
  {
    key: 'renewal_correction_template',
    audience: 'Commuter notifications',
    title: 'Student renewal needs correction',
    sentWhen: 'Sent when an admin asks for corrected enrollment proof.',
    defaultText: 'Please submit corrected enrollment proof within seven days. {reason}',
    variables: [NAME, REASON],
  },
  {
    key: 'renewal_rejected_template',
    audience: 'Commuter notifications',
    title: 'Student renewal rejected',
    sentWhen: 'Sent when an admin rejects a student renewal.',
    defaultText: 'Your student renewal was not approved. Your commuter type is now Regular. {reason}',
    variables: [NAME, REASON],
  },
  {
    key: 'renewal_expired_template',
    audience: 'Commuter notifications',
    title: 'Student discount expired',
    sentWhen: 'Sent automatically when the renewal deadline passes without a submission.',
    defaultText: 'Your student renewal deadline has passed. Your account remains available as a Regular commuter. Submit current enrollment proof to apply again.',
    variables: [NAME],
  },
  {
    key: 'remittance_reminder_template',
    audience: 'Conductor notifications',
    title: 'Remittance reminder',
    sentWhen: 'Sent repeatedly, at the Operations Rules interval, while a closed shift has cash not yet remitted.',
    defaultText: 'Shift {shift_id} still has PHP {amount} in expected cash awaiting remittance.',
    variables: [
      { name: 'conductor_name', sample: 'Juan Dela Cruz' },
      { name: 'shift_id', sample: 'SHF-8F2K91QX' },
      { name: 'unit_number', sample: 'CH-014' },
      { name: 'amount', sample: '1245.00' },
    ],
  },
];

// --- Expense Categories ---

export const initialExpenseCategories: string[] = [
  'Gas / Fuel',
  'Boundary / Remittance',
  'Vehicle Washing',
  'Tire Change / Repair',
];

// --- Default Config Values ---

export const defaultFinancialRules: FinancialRulesConfig = {
  ridesForFreeReward: '10',
  regularDiscount: '0',
  // Keep in sync with App\Support\FareRules::DEFAULTS.
  discountRate: '20',
  minimumFare: '17',
  succeedingFare: '2.40',
  baseBarangayCount: '4',
  // Keep in sync with config/registration.php student_renewal_month.
  studentRenewalMonth: '11',
};

export const defaultOperationsRules: OperationsRulesConfig = {
  // Keep in sync with LocationService::speedLimitKmh()'s fallback — this is
  // what Operations Rules shows before an admin has saved an explicit limit.
  speedLimitKmh: '50',
  maxShiftHours: '12',
  remittanceGraceMinutes: '30',
  remittanceReminderIntervalMinutes: '60',
};

export const defaultAppConfiguration: AppConfiguration = {
  maintenanceMode: false,
  maintenanceRoles: ['COMMUTER', 'CONDUCTOR'],
  maintenanceMessage:
    "CHATCO is currently undergoing scheduled maintenance. We'll be back online shortly — thank you for your patience!",
  requireIdUpload: true,
};

// The hotline is no longer edited in Settings; this is the fallback the SOS
// monitoring route shows when no saved emergency_hotline exists.
export const defaultSafetyConfig: SafetyConfig = {
  emergencyHotline: '911',
};

export const defaultReceiptConfig: ReceiptConfig = {
  businessName: 'CHATCO',
  addressLine: '',
  footerNote: 'Thank you for riding with Chatco!',
  paperWidth: '58',
  autoPrint: true,
  showDateTime: true,
  showTransactionId: true,
  showRoute: true,
  showUnit: true,
  showConductor: true,
  showPassenger: true,
  showFareBreakdown: true,
  showQrCode: true,
  showManualCode: true,
};
