<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Brings the seeded landing-page FAQs in line with what the system actually
 * does: commuters scan the conductor's QR (they have no QR of their own),
 * registration needs a valid ID and admin approval, SOS was removed, rewards
 * are a free-ride voucher every N rides (no points), Lost & Found is
 * browse-and-claim, and feedback is the in-jeep QR crew rating.
 *
 * FaqSeeder skips once any FAQ exists, so existing databases only get the new
 * copy through this migration (same approach as 2026_11_05_000001). A row is
 * rewritten only while both its question and answer still equal the original
 * seed, so anything an admin edited in FAQ Management is left alone.
 */
return new class extends Migration
{
    /** [category, old question, old answer, new question, new answer] */
    private const REPLACEMENTS = [
        ['getting-started',
            'How do I create a CHATCO account?',
            'Super easy! Sign up with your email or phone, pick "Commuter," and you\'re in. You\'ll get your QR code right away — no ID needed. Welcome aboard!',
            'How do I create an E-CHATCO account?',
            'Tap Sign up and complete four short steps: your personal details and commuter type (Regular, Student, Senior Citizen, or PWD), your contact number and a photo of your valid ID, the 6-digit code we email you, and your username and password. An admin then reviews your ID before your account is activated.'],
        ['getting-started',
            'What is my CHATCO QR code for?',
            'It\'s your digital boarding pass! Show it to the conductor, they scan it, and your fare is processed through GCash. No cash, no card — just your phone!',
            'Why is my account still pending?',
            'Every new account waits for an admin to check your valid ID and commuter type. You can sign in once it is approved. If it is not approved, you can register again with the correct details and ID.'],
        ['getting-started',
            'Is CHATCO free to use?',
            'Yep, totally free! You only pay when you ride — fares go directly through GCash. No subscriptions, no hidden fees, no wallet to maintain!',
            'Is E-CHATCO free to use?',
            'Yes. Creating an account and using the app cost nothing. You only pay your regular fare, by GCash or in cash.'],
        ['payments',
            'How do I pay for my ride?',
            'When you ride, show your QR code to the conductor. They scan it, select your fare based on your pickup and drop-off points, and you pay directly through GCash. No need to load a wallet beforehand!',
            'How do I pay with GCash?',
            'Tell the conductor where you are getting off and they will show a payment QR on their device. Tap Pay with GCash on your Home screen, scan that QR, check the amount, and confirm to finish on GCash\'s secure page.'],
        ['payments',
            'How is my fare calculated?',
            'Fares are based on official CHATCO point areas, not GPS distance. The route has 34 predefined stops, each with a set fare. Your fare depends on which point area you board from and where you get off. The conductor selects the nearest official point for computation.',
            'How is my fare calculated?',
            'Fares follow the 34 official CHATCO stop points, not GPS distance. Your fare depends on where you board and where you get off, and it is the same whether you pay by GCash or in cash. Open the fare calculator in the app to check a fare before you ride.'],
        ['payments',
            'Do I need a GCash account?',
            'Yes, for cashless payments you\'ll need a GCash account. When the conductor scans your QR, you\'ll receive a GCash payment prompt to confirm. You can also pay with cash directly to the conductor.',
            'Do I need a GCash account?',
            'Only to pay cashless. You can always pay the conductor in cash at the same fare.'],
        ['payments',
            'What happens if my ride is interrupted?',
            'If your trip is interrupted (e.g., engine breakdown), report the issue directly to the conductor or contact our support team. We\'ll work with you to resolve the situation as quickly as possible.',
            'What if my GCash payment doesn\'t go through?',
            'Nothing is charged until you confirm on GCash. If the payment fails or the QR expires, tap Try again and ask the conductor for a new QR, or pay in cash instead. Payment History shows the final status of each payment.'],
        ['riding',
            'How do I hail a jeepney?',
            'Open the map, tap Hail, and your location goes out to nearby conductors. When a CHATCO jeep is within 1km of your location, it appears on your map and you\'ll get a sound notification!',
            'How do I hail a jeepney?',
            'Press and hold Hold to Hail on the map. Your pickup point is sent to the nearest on-duty CHATCO jeep within 1 km of you, and the hail stays active for 3 minutes. You need to be near the route, and the jeep cannot be on break.'],
        ['riding',
            'Why can\'t I see all jeeps on the map?',
            'We only show CHATCO jeeps within 1km of your location to reduce map clutter, save bandwidth, and keep the app running smoothly. When a jeep approaches, you\'ll see it appear and hear a notification sound.',
            'Why can\'t I see all jeeps on the map?',
            'The map only shows CHATCO jeeps within 1 km of you, so it stays clear and shows the units you can actually catch, along with about how long each one will take to reach you.'],
        ['riding',
            'How do I pay when I ride?',
            'Two options! Show your QR code to the conductor — they scan it and fare is paid via GCash. Or pay with cash directly. Either way, the fare is the same based on the official point area rates.',
            'Can I pay for my companions?',
            'Yes. Tell the conductor how many are riding with you. They add your companions to one payment QR, and you pay the group total in a single GCash payment. Each passenger\'s Student, Senior Citizen, or PWD discount still applies.'],
        ['riding',
            'Can I share my ride with someone?',
            'Yep! Tap Share My Ride to send a live tracking link to family or friends. They\'ll see your location even without the app.',
            'Can I share my ride with someone?',
            'Yes. Tap Share Ride on your Home screen to create a live location link for family or friends. They can follow your trip in any browser without the app. The link stays live for 30 minutes, and you can stop sharing anytime.'],
        ['safety',
            'What is the SOS button?',
            'It\'s your emergency alert! Press it and your live location + ride details go straight to our admin team and your emergency contacts. Only use for real emergencies though!',
            'Is the jeepney\'s speed monitored?',
            'Yes. Every unit\'s speed is tracked live, and any trip over the speed limit is recorded for the operator\'s admins to review.'],
        ['safety',
            'I left something on the jeepney. What do I do?',
            'Don\'t panic! Go to Lost & Found and report the item with date, time, and route. Conductors and admins can match it with found items on their end.',
            'I left something on the jeepney. What do I do?',
            'Open Lost & Found to browse items conductors have turned in, with photos, the jeep\'s plate number, and when it was found. If one is yours, claim it and add proof of ownership. You can bookmark items and follow your claim\'s status. Unclaimed items stay listed for 30 days.'],
        ['safety',
            'Is my personal data safe?',
            'Absolutely! We use encrypted connections and secure storage through PayMongo for payments. Your QR code only has a unique ID — no personal info or payment details are exposed when scanned.',
            'Is my personal data safe?',
            'Yes. GCash payments are completed on GCash\'s own secure page through PayMongo, so E-CHATCO never sees your GCash PIN. Your ID photo is only used to review your registration and discount.'],
        ['safety',
            'How do I report a concern?',
            'Head to Feedback in the app! Rate your ride, report issues, or suggest improvements. Every report is reviewed by our team — your voice counts!',
            'How do I give feedback about my ride?',
            'Tap Feedback and scan the QR code inside the jeepney to rate the driver and conductor for that trip and leave a comment. For anything else, reach us through the Contact section on this page.'],
        ['rewards',
            'How does the loyalty program work?',
            'Every ride earns you points! The more you ride, the more you earn. Unlock perks like discounted fares, priority hailing, and exclusive vouchers.',
            'How does the loyalty program work?',
            'Every 10 paid rides earns you a free-ride voucher, and the count starts over so you can keep earning. GCash rides count automatically. For cash rides, open Rewards and scan the QR on your paper receipt.'],
        ['rewards',
            'How do I check my rewards?',
            'Check Rewards in the app! You\'ll see your points, available perks, and active vouchers for your next ride.',
            'How do I check my rewards?',
            'Open Rewards to see how many rides you have counted toward your next voucher and the vouchers you can use. You will also get a notification when a new voucher is ready.'],
        ['rewards',
            'Do points expire?',
            'Nope! Your points are yours forever. No expiration, no pressure!',
            'Do vouchers expire?',
            'Yes. A free-ride voucher is valid for 3 days after you earn it, and each voucher shows its expiry date. When you pay, the app offers your voucher automatically.'],
    ];

    /** [category, question, answer] — appended to the end of their category. */
    private const ADDITIONS = [
        ['payments',
            'How do I get a Student, Senior Citizen, or PWD discount?',
            'Choose your commuter type when you sign up and upload the matching ID. Already registered as Regular? Apply from your Profile. Once an admin approves it, the discount is applied to your fare automatically. Students renew their discount once a year.'],
        ['riding',
            'How do I know which way a jeep is going?',
            'Each jeep on the map points in its direction of travel, toward Calumpit or Meycauayan, so you can tell whether it is coming your way before you hail.'],
    ];

    public function up(): void
    {
        DB::transaction(function () {
            // A fresh database has nothing to refresh. Inserting the additions
            // here would make FaqSeeder see existing rows and skip everything.
            if (DB::table('faq_items')->doesntExist()) {
                return;
            }

            foreach (self::REPLACEMENTS as [, $oldQuestion, $oldAnswer, $newQuestion, $newAnswer]) {
                DB::table('faq_items')
                    ->where('question', $oldQuestion)
                    ->where('answer', $oldAnswer)
                    ->update(['question' => $newQuestion, 'answer' => $newAnswer, 'updated_at' => now()]);
            }

            foreach (self::ADDITIONS as [$category, $question, $answer]) {
                if (DB::table('faq_items')->where('question', $question)->exists()) {
                    continue;
                }
                $nextOrder = (int) DB::table('faq_items')->where('category', $category)->max('display_order') + 1;
                DB::table('faq_items')->insert([
                    'id' => (string) Str::uuid(),
                    'question' => $question,
                    'answer' => $answer,
                    'category' => $category,
                    'display_order' => $nextOrder,
                    'is_active' => true,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        });
    }

    public function down(): void
    {
        DB::transaction(function () {
            foreach (self::ADDITIONS as [, $question, $answer]) {
                DB::table('faq_items')->where('question', $question)->where('answer', $answer)->delete();
            }

            foreach (self::REPLACEMENTS as [, $oldQuestion, $oldAnswer, $newQuestion, $newAnswer]) {
                DB::table('faq_items')
                    ->where('question', $newQuestion)
                    ->where('answer', $newAnswer)
                    ->update(['question' => $oldQuestion, 'answer' => $oldAnswer, 'updated_at' => now()]);
            }
        });
    }
};
