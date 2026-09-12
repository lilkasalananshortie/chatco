<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class SchemaTest extends TestCase
{
    use RefreshDatabase;

    // ── Required Tables (17 total) ───────────────────────────────

    public function test_users_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('users'), 'Table [users] does not exist.');
    }

    public function test_personal_access_tokens_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('personal_access_tokens'), 'Table [personal_access_tokens] does not exist.');
    }

    public function test_commuter_profiles_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('commuter_profiles'), 'Table [commuter_profiles] does not exist.');
    }

    public function test_conductor_profiles_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('conductor_profiles'), 'Table [conductor_profiles] does not exist.');
    }

    public function test_admin_profiles_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('admin_profiles'), 'Table [admin_profiles] does not exist.');
    }

    public function test_drivers_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('drivers'), 'Table [drivers] does not exist.');
    }

    public function test_routes_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('routes'), 'Table [routes] does not exist.');
    }

    public function test_fare_points_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('fare_points'), 'Table [fare_points] does not exist.');
    }

    public function test_vehicles_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('vehicles'), 'Table [vehicles] does not exist.');
    }

    public function test_shift_logs_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('shift_logs'), 'Table [shift_logs] does not exist.');
    }

    public function test_transactions_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('transactions'), 'Table [transactions] does not exist.');
    }

    public function test_gcash_payment_intents_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('gcash_payment_intents'), 'Table [gcash_payment_intents] does not exist.');
    }

    public function test_remittances_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('remittances'), 'Table [remittances] does not exist.');
    }

    public function test_announcements_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('announcements'), 'Table [announcements] does not exist.');
    }

    public function test_lost_items_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('lost_items'), 'Table [lost_items] does not exist.');
    }

    public function test_claims_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('claims'), 'Table [claims] does not exist.');
    }

    public function test_vouchers_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('vouchers'), 'Table [vouchers] does not exist.');
    }

    // ── Total Table Count ────────────────────────────────────────

    public function test_required_table_count_is_17(): void
    {
        $requiredTables = [
            'users',
            'personal_access_tokens',
            'commuter_profiles',
            'conductor_profiles',
            'admin_profiles',
            'drivers',
            'routes',
            'fare_points',
            'vehicles',
            'shift_logs',
            'transactions',
            'gcash_payment_intents',
            'remittances',
            'announcements',
            'lost_items',
            'claims',
            'vouchers',
        ];

        $this->assertCount(17, $requiredTables, 'Expected exactly 17 required tables.');

        foreach ($requiredTables as $table) {
            $this->assertTrue(
                Schema::hasTable($table),
                "Required table [{$table}] is missing."
            );
        }
    }

    // ── Hard Constraint: NO Wallet Tables ─────────────────────────

    public function test_wallet_balance_table_does_not_exist(): void
    {
        $this->assertFalse(Schema::hasTable('wallet_balance'), 'Wallet table [wallet_balance] must NOT exist.');
    }

    public function test_wallet_transactions_table_does_not_exist(): void
    {
        $this->assertFalse(Schema::hasTable('wallet_transactions'), 'Wallet table [wallet_transactions] must NOT exist.');
    }

    public function test_wallet_ledger_table_does_not_exist(): void
    {
        $this->assertFalse(Schema::hasTable('wallet_ledger'), 'Wallet table [wallet_ledger] must NOT exist.');
    }

    // ── Key Column Checks ────────────────────────────────────────

    public function test_users_table_has_uuid_primary_key(): void
    {
        $this->assertTrue(Schema::hasColumn('users', 'id'), 'Users table missing [id] column.');
        $type = Schema::getColumnType('users', 'id');
        // Laravel 12 dropped Doctrine DBAL; native SQLite introspection returns
        // 'varchar' for uuid columns instead of the old Doctrine-normalized 'string'.
        $this->assertTrue(
            in_array($type, ['string', 'varchar', 'guid', 'text', 'uuid'], true),
            "Users.id must be UUID (string-like type), got [{$type}]."
        );
    }

    public function test_users_table_has_required_columns(): void
    {
        foreach (['id', 'email', 'password', 'role', 'created_at', 'updated_at', 'deleted_at'] as $col) {
            $this->assertTrue(Schema::hasColumn('users', $col), "Users table missing [{$col}] column.");
        }
    }

    public function test_users_table_excludes_unwanted_columns(): void
    {
        foreach (['name', 'phone', 'email_verified_at', 'is_active'] as $col) {
            $this->assertFalse(Schema::hasColumn('users', $col), "Users table must NOT have [{$col}] column.");
        }
    }

    public function test_shift_logs_uses_string_primary_key(): void
    {
        $this->assertTrue(Schema::hasColumn('shift_logs', 'shift_id'), 'Shift logs missing [shift_id] column.');
    }

    public function test_transactions_uses_string_primary_key(): void
    {
        $this->assertTrue(Schema::hasColumn('transactions', 'transaction_id'), 'Transactions missing [transaction_id] column.');
    }

    public function test_no_wallet_columns_in_any_table(): void
    {
        $allTables = Schema::getTableListing();

        foreach ($allTables as $table) {
            $this->assertFalse(
                Schema::hasColumn($table, 'wallet_balance'),
                "Table [{$table}] must NOT have a [wallet_balance] column."
            );
        }
    }

    // ── Sprint 2 Schema Additions ────────────────────────────────

    public function test_vehicle_locations_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('vehicle_locations'), 'Table [vehicle_locations] does not exist.');
    }

    // ── Sprint 3 Tables ──────────────────────────────────────────

    public function test_hails_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('hails'));
    }

    // ── Column Checks ────────────────────────────────────────────

    public function test_vehicle_locations_has_required_columns(): void
    {
        $columns = ['vehicle_id', 'conductor_id', 'lat', 'lng', 'speed', 'heading', 'capacity_status', 'updated_at'];

        foreach ($columns as $column) {
            $this->assertTrue(
                Schema::hasColumn('vehicle_locations', $column),
                "Missing column: vehicle_locations.{$column}"
            );
        }
    }

    public function test_vehicle_locations_has_no_wallet_columns(): void
    {
        $this->assertFalse(Schema::hasColumn('vehicle_locations', 'wallet_id'));
        $this->assertFalse(Schema::hasColumn('vehicle_locations', 'wallet_balance'));
    }

    public function test_shift_logs_has_status_column(): void
    {
        $this->assertTrue(Schema::hasColumn('shift_logs', 'status'), 'shift_logs missing [status] column.');
    }

    public function test_shift_logs_has_driver_id_column(): void
    {
        $this->assertTrue(Schema::hasColumn('shift_logs', 'driver_id'), 'shift_logs missing [driver_id] column.');
    }

    public function test_vehicles_has_active_shift_id_column(): void
    {
        $this->assertTrue(Schema::hasColumn('vehicles', 'active_shift_id'), 'vehicles missing [active_shift_id] column.');
    }

    public function test_drivers_has_active_shift_id_column(): void
    {
        $this->assertTrue(Schema::hasColumn('drivers', 'active_shift_id'), 'drivers missing [active_shift_id] column.');
    }

    // ── Sprint 6 Tables ──────────────────────────────────────────

    public function test_feedback_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('feedback'), 'Table [feedback] does not exist.');
    }

    public function test_feedback_has_required_columns(): void
    {
        $columns = ['id', 'shift_id', 'vehicle_id', 'driver_id', 'conductor_id', 'commuter_id', 'rating', 'category', 'comment', 'created_at', 'updated_at'];

        foreach ($columns as $column) {
            $this->assertTrue(
                Schema::hasColumn('feedback', $column),
                "Missing column: feedback.{$column}"
            );
        }
    }

    // ── Sprint 6 (T3) Lost & Found new columns ──────────────────

    public function test_lost_items_has_release_and_audit_columns(): void
    {
        $columns = ['released_to', 'released_at', 'closed_by', 'closed_at'];
        foreach ($columns as $column) {
            $this->assertTrue(
                Schema::hasColumn('lost_items', $column),
                "Missing column: lost_items.{$column}"
            );
        }
    }

    public function test_claims_has_review_columns(): void
    {
        $columns = ['reviewed_by', 'reviewed_at', 'rejection_reason'];
        foreach ($columns as $column) {
            $this->assertTrue(
                Schema::hasColumn('claims', $column),
                "Missing column: claims.{$column}"
            );
        }
    }

    // ── Sprint 6 (T4) Announcements new table + columns ─────────

    public function test_announcement_reads_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('announcement_reads'), 'Table [announcement_reads] does not exist.');
    }

    public function test_announcements_has_created_by_and_status(): void
    {
        $this->assertTrue(Schema::hasColumn('announcements', 'created_by'), 'Missing column: announcements.created_by');
        $this->assertTrue(Schema::hasColumn('announcements', 'status'), 'Missing column: announcements.status');
    }

    // ── Sprint 6 (T5) SOS alerts table ──────────────────────────

    public function test_sos_alerts_table_exists(): void
    {
        $this->assertTrue(Schema::hasTable('sos_alerts'), 'Table [sos_alerts] does not exist.');
    }

    public function test_sos_alerts_has_required_columns(): void
    {
        $columns = ['id', 'commuter_id', 'lat', 'lng', 'note', 'status', 'acknowledged_by', 'acknowledged_at', 'resolved_by', 'resolved_at', 'created_at', 'updated_at'];

        foreach ($columns as $column) {
            $this->assertTrue(
                Schema::hasColumn('sos_alerts', $column),
                "Missing column: sos_alerts.{$column}"
            );
        }
    }
}
