<?php

namespace Database\Seeders;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\Route;
use App\Models\User;
use App\Models\Vehicle;
use App\Support\FareRules;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // ════════════════════════════════════════════════════
        // 1. USERS & PROFILES
        // ════════════════════════════════════════════════════

        // ── Admin ──
        $admin = User::create([
            'email' => 'admin@gmail.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id' => $admin->id,
            'first_name' => 'System',
            'middle_name' => null,
            'last_name' => 'Admin',
            'profile_picture_url' => null,
        ]);

        // admin1@gmail.com … admin10@gmail.com
        $adminSpecs = [
            ['Andrea',    null,        'Bautista'],
            ['Benjamin',  'Ramos',     'Aquino'],
            ['Cristina',  null,        'Navarro'],
            ['Daniel',    'Castro',    'Mercado'],
            ['Elena',     null,        'Salvador'],
            ['Francisco', 'Lopez',     'Domingo'],
            ['Gabriela',  null,        'Pascual'],
            ['Hector',    'Rivera',    'Gonzales'],
            ['Isabel',    null,        'Fernandez'],
            ['Julian',    'Morales',   'Castillo'],
        ];

        foreach ($adminSpecs as $i => [$firstName, $middleName, $lastName]) {
            $user = User::create([
                'email' => 'admin'.($i + 1).'@gmail.com',
                'password' => Hash::make('password123'),
                'role' => UserRole::ADMIN,
            ]);
            AdminProfile::create([
                'id' => $user->id,
                'first_name' => $firstName,
                'middle_name' => $middleName,
                'last_name' => $lastName,
                'profile_picture_url' => null,
            ]);
        }

        // ── Conductors ──
        // conductor1@gmail.com … conductor20@gmail.com, usernames
        // conductor001 … conductor020.
        $conductorSpecs = [
            ['Juan',      null,        'Dela Cruz',   '1990-03-15'],
            ['Maria',     'Santos',    'Reyes',       '1992-07-20'],
            ['Paolo',     null,        'Manalo',      '1991-02-11'],
            ['Kristine',  'Abad',      'Soriano',     '1994-09-03'],
            ['Mark',      null,        'Villareal',   '1989-12-27'],
            ['Angelica',  'Dizon',     'Ocampo',      '1995-05-08'],
            ['Jerome',    null,        'Panganiban',  '1988-10-19'],
            ['Rowena',    'Tan',       'Lacson',      '1993-01-30'],
            ['Nestor',    null,        'Galang',      '1987-06-14'],
            ['Liza',      'Cortez',    'Samonte',     '1996-04-22'],
            ['Ramil',     null,        'Bernabe',     '1990-08-09'],
            ['Jocelyn',   'Mallari',   'Tolentino',   '1992-11-16'],
            ['Arnel',     null,        'Sarmiento',   '1986-02-25'],
            ['Princess',  'Yap',       'Villanueva',  '1997-06-01'],
            ['Dennis',    null,        'Macaraeg',    '1989-04-13'],
            ['Marites',   'Gomez',     'Evangelista', '1991-12-05'],
            ['Rodel',     null,        'Cunanan',     '1993-03-28'],
            ['Shiela',    'Ignacio',   'Dimaculangan', '1995-10-10'],
            ['Wilfredo',  null,        'Santiago',    '1985-07-21'],
            ['Analyn',    'Pineda',    'Manansala',   '1994-01-17'],
        ];

        foreach ($conductorSpecs as $i => [$firstName, $middleName, $lastName, $birthday]) {
            $number = $i + 1;
            $user = User::create([
                'email' => "conductor{$number}@gmail.com",
                'password' => Hash::make('password123'),
                'role' => UserRole::CONDUCTOR,
            ]);
            ConductorProfile::create([
                'id' => $user->id,
                'first_name' => $firstName,
                'middle_name' => $middleName,
                'last_name' => $lastName,
                'birthday' => $birthday,
                'profile_picture_url' => null,
                'generated_username' => 'conductor'.str_pad($number, 3, '0', STR_PAD_LEFT),
                'generated_password' => Hash::make('password123'),
            ]);
        }

        // ── Commuters ──
        // Seeded separately in CommuterSeeder (20 PH-celebrity accounts across
        // every discount tier + account status). See the $this->call() at the
        // end of this method.

        // ════════════════════════════════════════════════════
        // 2. ROUTE — McArthur Highway
        // ════════════════════════════════════════════════════

        // The cooperative's 33 main places and their sub places, in route order.
        $barangayStops = config('chatco_route.fare_points');

        // The verified road line is both the live line and the editor's control points.
        $route = Route::create([
            'name' => 'McArthur Highway — Calumpit to Meycauayan',
            'status' => 'ACTIVE',
            'waypoints' => config('chatco_route.bootstrap_geometry'),
            'geometry' => config('chatco_route.bootstrap_geometry'),
        ]);

        // ════════════════════════════════════════════════════
        // 3. FARE POINTS — 33 Barangays
        // ════════════════════════════════════════════════════

        // Each stop stores its fare from stop 1 under the default Financial Rules.
        $fareRules = FareRules::fromValues([]);

        foreach ($barangayStops as $index => $stop) {
            $pointNumber = $index + 1;
            $regularFare = $fareRules->fare($pointNumber);
            $discountedFare = $fareRules->fare($pointNumber, true);

            FarePoint::create([
                'route_id' => $route->id,
                'point_number' => $pointNumber,
                'code' => $stop['code'],
                'name' => $stop['name'],
                'landmarks' => null,
                'sub_stops' => $stop['sub_stops'], // auto JSON via cast
                'regular_fare' => $regularFare,
                'discounted_fare' => $discountedFare,
                // Pinned by an admin in Fare Matrix.
                'latitude' => null,
                'longitude' => null,
            ]);
        }

        // ════════════════════════════════════════════════════
        // 4. DRIVERS (20) + 5. VEHICLES (40)
        // ════════════════════════════════════════════════════
        // Generates 20 drivers and 40 vehicles with realistic Philippine
        // names, proper plate numbers (XXX NNNN format), and unit
        // numbers (UNIT-NNN format). There are more units than drivers, as
        // in a real fleet where some units sit idle on any given shift.
        //
        // Vehicles start UNASSIGNED — no current driver or conductor. The
        // driver + conductor assignment happens dynamically through the
        // conductor login workflow (startShift sets vehicle.driver_id /
        // conductor_id) and is cleared on EOD / the daily reset. Drivers
        // likewise start with no vehicle so they appear in the conductor's
        // available-driver pool.

        $driverSpecs = [
            ['Pedro',     'Santos',       '1985-06-10', '09171112222', '2023-01-15'],
            ['Ricardo',   'Cruz',         '1988-09-22', '09172223333', '2023-03-01'],
            ['Antonio',   'Garcia',       '1990-12-05', '09173334444', '2023-06-20'],
            ['Manuel',    'Reyes',        '1983-04-18', '09174445555', '2022-11-10'],
            ['Roberto',   'Flores',       '1987-08-30', '09175556666', '2023-02-14'],
            ['Eduardo',   'Lim',          '1991-01-25', '09176667777', '2023-09-05'],
            ['Fernando',  'Torres',       '1986-07-12', '09177778888', '2023-04-22'],
            ['Jose',      'Mendoza',      '1989-03-08', '09178889999', '2023-07-30'],
            ['Ramon',     'Villanueva',   '1984-11-17', '09179990000', '2022-08-15'],
            ['Carlos',    'Dela Rosa',    '1992-05-20', '09170001111', '2023-10-12'],
            ['Alfredo',   'Bautista',     '1984-02-14', '09181112222', '2022-09-01'],
            ['Rogelio',   'Mercado',      '1987-05-30', '09182223333', '2023-01-23'],
            ['Danilo',    'Aquino',       '1990-10-08', '09183334444', '2023-05-17'],
            ['Ernesto',   'Pascual',      '1982-12-19', '09184445555', '2022-06-06'],
            ['Romeo',     'Navarro',      '1988-03-03', '09185556666', '2023-08-11'],
            ['Virgilio',  'Salazar',      '1985-09-26', '09186667777', '2022-12-02'],
            ['Arturo',    'Galvez',       '1991-07-07', '09187778888', '2023-11-20'],
            ['Leonardo',  'Ramos',        '1986-01-31', '09188889999', '2023-02-27'],
            ['Benjie',    'Soriano',      '1993-08-15', '09189990000', '2024-01-08'],
            ['Rolando',   'De Guzman',    '1983-06-22', '09180001111', '2022-10-14'],
        ];

        // Plate number prefixes — Philippine region-style codes, cycled across
        // the 40 units (the 4-digit number keeps every plate unique).
        $platePrefixes = ['NAA', 'NAB', 'NAC', 'NBC', 'NBD', 'DAB', 'DAC', 'AAD', 'AAE', 'PAA'];

        foreach ($driverSpecs as $i => $spec) {
            [$firstName, $lastName, $birthday, $contact, $hireDate] = $spec;

            // Generate unique license number
            $licenseNumber = 'DL-2024-'.str_pad($i + 1, 4, '0', STR_PAD_LEFT);

            // Create the driver — starts with no vehicle (unassigned pool).
            Driver::create([
                'first_name' => $firstName,
                'middle_name' => null,
                'last_name' => $lastName,
                'birthday' => $birthday,
                'contact' => $contact,
                'license_number' => $licenseNumber,
                'hire_date' => $hireDate,
                'profile_picture_url' => null,
                'status' => 'ACTIVE',
                'vehicle_id' => null,
            ]);
        }

        for ($i = 0; $i < 40; $i++) {
            // Generate unique plate: XXX NNNN (3 letters + space + 4 digits)
            $plateNumber = $platePrefixes[$i % count($platePrefixes)].' '.str_pad($i + 1, 4, '0', STR_PAD_LEFT);

            // Generate unique unit number: UNIT-001 through UNIT-040
            $unitNumber = 'UNIT-'.str_pad($i + 1, 3, '0', STR_PAD_LEFT);

            // Create the vehicle — starts UNASSIGNED (no current driver or
            // conductor). Assignment happens at conductor login, not here.
            Vehicle::create([
                'unit_number' => $unitNumber,
                'plate_number' => $plateNumber,
                'route_id' => $route->id,
                'driver_id' => null,
                'conductor_id' => null,
                'status' => 'ACTIVE',
                'capacity_status' => 'AVAILABLE',
            ]);
        }

        // ════════════════════════════════════════════════════
        // 6. TRANSACTIONAL / OPERATIONAL DATA (separate seeders)
        // ════════════════════════════════════════════════════
        // Split into focused seeders so each dataset is easy to inspect and can
        // be re-run in isolation (php artisan db:seed --class=XxxSeeder).
        // Shifts, transactions (receipts) and remittances start empty and
        // come from real use. For demo history, run in this order:
        //   db:seed --class=ShiftLogSeeder → TransactionSeeder → RemittanceSeeder
        $this->call([
            CommuterSeeder::class,      // 20 PH-celebrity + 30 generated commuters
            AnnouncementSeeder::class,  // system announcements feed
            FaqSeeder::class,           // landing-page FAQ chat content
        ]);
    }
}
