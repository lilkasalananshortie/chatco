<?php

namespace Database\Seeders;

use App\Models\FaqItem;
use Illuminate\Database\Seeder;

/**
 * Seeds the faq_items table with the landing-page FAQ chat content.
 * Mirrors the copy that migration 2026_11_22_000001_complete_landing_faqs
 * brings existing databases to.
 *
 * Idempotent: skips entirely if any FAQ already exists, so it never clobbers
 * items an admin has added or edited via /settings/faq-management.
 */
class FaqSeeder extends Seeder
{
    public function run(): void
    {
        if (FaqItem::query()->exists()) {
            return;
        }

        $byCategory = [
            'getting-started' => [
                ['How do I create an E-CHATCO account?', 'Tap Sign up and complete four short steps: your personal details and commuter type (Regular, Student, Senior Citizen, or PWD), your contact number and a photo of your valid ID, the 6-digit code we email you, and your username and password. An admin then reviews your ID before your account is activated.'],
                ['Why is my account still pending?', 'Every new account waits for an admin to check your valid ID and commuter type. You can sign in once it is approved. If it is not approved, you can register again with the correct details and ID.'],
                ['Is E-CHATCO free to use?', 'Yes. Creating an account and using the app cost nothing. You only pay your regular fare, by GCash or in cash.'],
                ['Where does E-CHATCO operate?', 'E-CHATCO runs on the Calumpit–Meycauayan route in Bulacan, with 34 official stop points.'],
                ['What time is the first trip and last trip?', 'The first trip starts at 4:10 AM on weekdays and 5:00 AM on weekends. Trips run until 9:00 PM every day.'],
                ['I forgot my password. What do I do?', 'Tap Forgot password and enter your account email. We will send a code that works for 15 minutes, then you can set a new password. This signs you out on your other devices. Accounts still pending approval cannot reset a password yet.'],
                ['Why can\'t I sign in or sign up right now?', 'E-CHATCO may be under maintenance. Sign-in and registration return once it ends. If your account is new, it may also still be waiting for admin approval.'],
            ],
            'payments' => [
                ['How do I pay with GCash?', 'Tell the conductor where you are getting off and they will show a payment QR on their device. Tap Pay with GCash on your Home screen, scan that QR, check the amount, and confirm to finish on GCash\'s secure page.'],
                ['How is my fare calculated?', 'Fares follow the 34 official CHATCO stop points, not GPS distance. Your fare depends on where you board and where you get off, and it is the same whether you pay by GCash or in cash. Open the fare calculator in the app to check a fare before you ride.'],
                ['Do I need a GCash account?', 'Only to pay cashless. You can always pay the conductor in cash at the same fare.'],
                ['What if my GCash payment doesn\'t go through?', 'Nothing is charged until you confirm on GCash. If the payment fails or the QR expires, tap Try again and ask the conductor for a new QR, or pay in cash instead. Payment History shows the final status of each payment.'],
                ['How do I get a Student, Senior Citizen, or PWD discount?', 'Choose your commuter type when you sign up and upload the matching ID. Already registered as Regular? Apply from your Profile. Once an admin approves it, the discount is applied to your fare automatically. Students renew once a year, and PWD cardholders renew when their ID expires.'],
                ['How do I renew my Student or PWD discount?', 'When your renewal is due, you will get a reminder in the app. Students submit a current school ID or enrollment proof, and PWD cardholders submit their renewed ID and its valid-until date. An admin reviews it and may ask for a correction. If you do not renew in time, your fare returns to the regular rate.'],
            ],
            'riding' => [
                ['How do I hail a jeepney?', 'Press and hold Hold to Hail on the map. Your pickup point is sent to the nearest on-duty CHATCO jeep within 1 km of you, and the hail stays active for 3 minutes. You need to be near the route, and the jeep cannot be full or on break.'],
                ['Why can\'t I hail a jeep I can see on the map?', 'The map shows all on-duty CHATCO jeeps, but you can only hail one that is within 1 km of you and not full. You also need to be within 1 km of the route. ETA appears for jeeps you can hail.'],
                ['Why is a jeep missing from the map?', 'A jeep appears only while it is on an active trip and sending its location. It will not show if the conductor is on break, has ended the shift, or has lost GPS signal.'],
                ['How do I know which way a jeep is going?', 'Each jeep on the map points in its direction of travel, toward Calumpit or Meycauayan, so you can tell whether it is coming your way before you hail.'],
                ['Can I pay for my companions?', 'Yes. Tell the conductor how many are riding with you. They add your companions to one payment QR, and you pay the group total in a single GCash payment. Each passenger\'s Student, Senior Citizen, or PWD discount still applies.'],
                ['Can I share my ride with someone?', 'Yes. Tap Share Ride on your Home screen to create a live location link for family or friends. They can follow your trip in any browser without the app. The link stays live for 30 minutes, and you can stop sharing anytime.'],
            ],
            'safety' => [
                ['Is the jeepney\'s speed monitored?', 'Yes. Every unit\'s speed is tracked live, and any trip over the speed limit is recorded for the operator\'s admins to review.'],
                ['I left something on the jeepney. What do I do?', 'Open Lost & Found to browse items conductors have turned in, with photos, the jeep\'s plate number, and when it was found. If one is yours, claim it and add proof of ownership. You can bookmark items and follow your claim\'s status. Unclaimed items stay listed for 30 days.'],
                ['Is my personal data safe?', 'Yes. GCash payments are completed on GCash\'s own secure page through PayMongo, so E-CHATCO never sees your GCash PIN. Your ID photo is only used to review your registration and discount.'],
                ['How do I give feedback about my ride?', 'Tap Feedback and scan the QR code inside the jeepney to rate the driver and conductor for that trip and leave a comment. For anything else, reach us through the Contact section on this page.'],
            ],
            'rewards' => [
                ['How does the loyalty program work?', 'Every 10 paid rides earns you a free-ride voucher, and the count starts over so you can keep earning. GCash rides count automatically. For cash rides, open Rewards and scan the QR on your paper receipt.'],
                ['How do I count a cash ride?', 'Keep the paper receipt from the conductor. Sign in, open Rewards, and scan the receipt\'s QR. GCash rides count automatically.'],
                ['How do I check my rewards?', 'Open Rewards to see how many rides you have counted toward your next voucher and the vouchers you can use. You will also get a notification when a new voucher is ready.'],
                ['Do vouchers expire?', 'Yes. A free-ride voucher is valid for 3 days after you earn it, and each voucher shows its expiry date. When you pay, the app offers your voucher automatically.'],
                ['Where can I see announcements?', 'Open Rewards & Announcements. A badge on the tab shows when you have unread updates.'],
            ],
        ];

        foreach ($byCategory as $category => $items) {
            foreach ($items as $order => [$question, $answer]) {
                FaqItem::create([
                    'question'      => $question,
                    'answer'        => $answer,
                    'category'      => $category,
                    'display_order' => $order,
                    'is_active'     => true,
                ]);
            }
        }
    }
}
