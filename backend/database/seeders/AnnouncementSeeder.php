<?php

namespace Database\Seeders;

use App\Enums\UserRole;
use App\Models\Announcement;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * AnnouncementSeeder — admin-published system announcements for the
 * commuter/conductor feed and the admin announcements manager.
 *
 * 17 announcements covering every category the UI maps (SYSTEM / SAFETY /
 * PROMO / MAINTENANCE / ROUTE / HOLIDAY), with ARCHIVED rows so the
 * archived/active filter has something on both sides. `created_by` is attributed to the seeded admin.
 *
 * Depends on: an admin user existing.
 * Run alone with:  php artisan db:seed --class=AnnouncementSeeder
 */
class AnnouncementSeeder extends Seeder
{
    public function run(): void
    {
        // Prefer the system admin; with several admins seeded, first() alone
        // would pick an arbitrary one (UUID primary keys have no insert order).
        $admin = User::where('email', 'admin@gmail.com')->first()
            ?? User::where('role', UserRole::ADMIN)->first();

        // [type, title, message, status, daysAgo]
        $items = [
            ['SYSTEM', 'Welcome to Chatco', 'The Chatco fare & remittance system is now live. Tap your route to see fares and track your ride in real time.', 'ACTIVE', 9],
            ['SAFETY', 'Buckle Up & Mind Your Belongings', 'For your safety, please hold on to the handrails and keep your valuables secure while the jeepney is moving.', 'ACTIVE', 7],
            ['PROMO', 'Ride & Earn Free Trips', 'Every 10 paid rides earns you 1 free voucher ride. Check the Rewards tab to see your progress.', 'ACTIVE', 5],
            ['ROUTE', 'McArthur Highway Advisory', 'Expect light rerouting near Plaridel Poblacion due to ongoing road works. Allow a few extra minutes for your trip.', 'ACTIVE', 3],
            ['MAINTENANCE', 'Scheduled Maintenance', 'The app may be briefly unavailable on Sunday, 2:00–3:00 AM, for scheduled maintenance. Thank you for your patience.', 'ACTIVE', 2],
            ['HOLIDAY', 'Holiday Schedule', 'Trips will follow a reduced schedule on the upcoming public holiday. Please plan your travel accordingly.', 'ACTIVE', 1],
            ['PROMO', 'Old Fiesta Promo (Ended)', 'The town fiesta discount promo has ended. Thank you to everyone who joined!', 'ARCHIVED', 20],
            ['SYSTEM', 'Pay Your Fare with GCash', 'Scan the QR code shown by your conductor and pay through GCash. Your receipt appears in the app as soon as the payment goes through.', 'ACTIVE', 12],
            ['SYSTEM', 'Waiting for a Ride? Use Pick Me Up', 'Press and hold Pick Me Up on the map to let the nearest conductor know you are waiting at the roadside.', 'ACTIVE', 11],
            ['SAFETY', 'Share Your Ride with Family', 'Generate a Share My Ride link so family and friends can follow your trip live until you arrive.', 'ACTIVE', 10],
            ['ROUTE', 'Heavy Traffic at Crossing Malolos', 'Expect slow traffic around Crossing Malolos during the morning and evening rush. Plan your trip a little earlier.', 'ACTIVE', 8],
            ['SYSTEM', 'Lost Something on a Jeepney?', 'Report lost items in the Lost & Found tab. Conductors log found items at the end of each trip, and the admin will contact you when there is a match.', 'ACTIVE', 6],
            ['PROMO', 'Vouchers Now Valid for 3 Days', 'Free ride vouchers earned from 10 paid rides are now valid for 3 days. Use yours before it expires.', 'ACTIVE', 4],
            ['MAINTENANCE', 'Live Tracking Briefly Paused', 'Live jeepney tracking may pause for a few minutes tonight while we update our servers. Fare payments are not affected.', 'ACTIVE', 2],
            ['ROUTE', 'Road Repairs near Tuktukan', 'One lane is closed along McArthur Highway near Tuktukan for road repairs. Jeepneys may take a few minutes longer.', 'ACTIVE', 1],
            ['HOLIDAY', "All Saints' Day Trips", "Expect more passengers bound for cemeteries along the route on All Saints' Day. Units will run until late evening.", 'ARCHIVED', 14],
            ['SYSTEM', 'Discount Verification Reminder', 'Students, seniors and PWD riders: keep your ID ready when boarding. Conductors may ask to see it before applying the discounted fare.', 'ACTIVE', 0],
        ];

        foreach ($items as [$type, $title, $message, $status, $daysAgo]) {
            $announcement = Announcement::create([
                'type'       => $type,
                'title'      => $title,
                'message'    => $message,
                'status'     => $status,
                'created_by' => $admin?->id,
            ]);

            $ts = now()->subDays($daysAgo);
            $announcement->created_at = $ts;
            $announcement->updated_at = $ts;
            $announcement->save();
        }

        $this->command?->info('Seeded ' . count($items) . ' announcements.');
    }
}
