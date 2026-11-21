<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Brings existing databases to the full 28-question landing FAQ.
 *
 * Databases migrated from empty before this date hold only the two rows
 * 2026_11_09_000001 inserted, and those rows made FaqSeeder skip the rest.
 * Those databases get the whole set in its intended order. Databases that were
 * seeded normally only receive the new questions, appended to their category,
 * so FAQs an admin deleted, reworded or reordered are not undone.
 *
 * An empty table is left for FaqSeeder. Rows stay ordinary faq_items, fully
 * editable in Settings > FAQ Management.
 */
return new class extends Migration
{
    /** [old question, old answer, new question, new answer] */
    private const REWRITES = [
        ['How do I get a Student, Senior Citizen, or PWD discount?',
            'Choose your commuter type when you sign up and upload the matching ID. Already registered as Regular? Apply from your Profile. Once an admin approves it, the discount is applied to your fare automatically. Students renew their discount once a year.',
            'How do I get a Student, Senior Citizen, or PWD discount?',
            'Choose your commuter type when you sign up and upload the matching ID. Already registered as Regular? Apply from your Profile. Once an admin approves it, the discount is applied to your fare automatically. Students renew once a year, and PWD cardholders renew when their ID expires.'],
        ['How do I hail a jeepney?',
            'Press and hold Hold to Hail on the map. Your pickup point is sent to the nearest on-duty CHATCO jeep within 1 km of you, and the hail stays active for 3 minutes. You need to be near the route, and the jeep cannot be on break.',
            'How do I hail a jeepney?',
            'Press and hold Hold to Hail on the map. Your pickup point is sent to the nearest on-duty CHATCO jeep within 1 km of you, and the hail stays active for 3 minutes. You need to be near the route, and the jeep cannot be full or on break.'],
        ['Why can\'t I see all jeeps on the map?',
            'The map only shows CHATCO jeeps within 1 km of you, so it stays clear and shows the units you can actually catch, along with about how long each one will take to reach you.',
            'Why can\'t I hail a jeep I can see on the map?',
            'The map shows all on-duty CHATCO jeeps, but you can only hail one that is within 1 km of you and not full. You also need to be within 1 km of the route. ETA appears for jeeps you can hail.'],
    ];

    /** Inserted by 2026_11_09_000001 even on an otherwise empty table. */
    private const NOV_9_ADDITIONS = [
        'How do I get a Student, Senior Citizen, or PWD discount?',
        'How do I know which way a jeep is going?',
    ];

    private const NEW_QUESTIONS = [
        'Where does E-CHATCO operate?',
        'I forgot my password. What do I do?',
        'Why can\'t I sign in or sign up right now?',
        'How do I renew my Student or PWD discount?',
        'Why is a jeep missing from the map?',
        'How do I count a cash ride?',
        'Where can I see announcements?',
    ];

    /** Mirrors FaqSeeder: category => [[question, answer], ...] in display order. */
    private const FAQS = [
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

    public function up(): void
    {
        DB::transaction(function () {
            if (DB::table('faq_items')->doesntExist()) {
                return;
            }

            foreach (self::REWRITES as [$oldQuestion, $oldAnswer, $newQuestion, $newAnswer]) {
                DB::table('faq_items')
                    ->where('question', $oldQuestion)
                    ->where('answer', $oldAnswer)
                    ->update(['question' => $newQuestion, 'answer' => $newAnswer, 'updated_at' => now()]);
            }

            $allQuestions = array_merge(...array_map(fn (array $items) => array_column($items, 0), array_values(self::FAQS)));
            $baseQuestions = array_values(array_diff($allQuestions, self::NEW_QUESTIONS, self::NOV_9_ADDITIONS));
            $restoreAll = DB::table('faq_items')->whereIn('question', $baseQuestions)->doesntExist();

            foreach (self::FAQS as $category => $items) {
                if ($restoreAll) {
                    // Keep any admin-written questions after the restored set.
                    DB::table('faq_items')
                        ->where('category', $category)
                        ->whereNotIn('question', array_column($items, 0))
                        ->increment('display_order', count($items));
                }

                foreach ($items as $order => [$question, $answer]) {
                    $existingId = DB::table('faq_items')->where('question', $question)->value('id');

                    if ($existingId !== null) {
                        if ($restoreAll) {
                            DB::table('faq_items')->where('id', $existingId)->update(['display_order' => $order]);
                        }

                        continue;
                    }

                    if (! $restoreAll && ! in_array($question, self::NEW_QUESTIONS, true)) {
                        continue;
                    }

                    DB::table('faq_items')->insert([
                        'id' => (string) Str::uuid(),
                        'question' => $question,
                        'answer' => $answer,
                        'category' => $category,
                        'display_order' => $restoreAll
                            ? $order
                            : (int) DB::table('faq_items')->where('category', $category)->max('display_order') + 1,
                        'is_active' => true,
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]);
                }
            }
        });
    }

    /** Removes unedited new questions and reverts unedited rewrites. */
    public function down(): void
    {
        DB::transaction(function () {
            foreach (self::FAQS as $items) {
                foreach ($items as [$question, $answer]) {
                    if (in_array($question, self::NEW_QUESTIONS, true)) {
                        DB::table('faq_items')->where('question', $question)->where('answer', $answer)->delete();
                    }
                }
            }

            foreach (self::REWRITES as [$oldQuestion, $oldAnswer, $newQuestion, $newAnswer]) {
                DB::table('faq_items')
                    ->where('question', $newQuestion)
                    ->where('answer', $newAnswer)
                    ->update(['question' => $oldQuestion, 'answer' => $oldAnswer, 'updated_at' => now()]);
            }
        });
    }
};
