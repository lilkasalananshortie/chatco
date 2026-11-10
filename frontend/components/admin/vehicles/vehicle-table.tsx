'use client';

// components/admin/vehicles/vehicle-table.tsx
import { DataTable } from '@/components/admin/ui/data-table';
import { TablePagination } from '@/components/admin/ui/table-pagination';
import { SearchBar } from '@/components/admin/ui/search-bar';
import { Pencil, Clock, Plus, Trash2, Eye } from 'lucide-react';
import type { PageMeta, Vehicle } from '@/app/(admin)/vehicles/data/vehicles-data';
import { SkeletonTable } from '@/components/admin/ui/skeleton';
import { RowActionsMenu } from '@/components/admin/ui/row-actions-menu';

// REMOVED the hardcoded mockVehicles array since we are getting it from the page now

interface VehicleTableProps {
  vehicles: Vehicle[];
  searchQuery: string;
  page: PageMeta;
  onPageChange: (page: number) => void;
  onSearchChange: (value: string) => void;
  onAddVehicle: () => void;
  onEdit: (vehicle: Vehicle) => void;
  onEditShift: (vehicle: Vehicle) => void;
  onDelete: (vehicle: Vehicle) => void;
  /** Double-clicking a row opens the vehicle details (incl. permanent QR). */
  onRowDoubleClick?: (vehicle: Vehicle) => void;
  isLoading?: boolean;
}

export function VehicleTable({
  vehicles,
  searchQuery,
  page,
  onPageChange,
  onSearchChange,
  onAddVehicle,
  onEdit,
  onEditShift,
  onDelete,
  onRowDoubleClick,
  isLoading = false,
}: VehicleTableProps) {
  const columns = [
    {
      key: 'unitNumber',
      label: 'Unit',
      cellClassName: 'whitespace-nowrap',
      render: (value: string) => (
        <p className="font-semibold text-white admin-light:text-slate-900">{value}</p>
      ),
    },
    { key: 'plateNumber', label: 'Plate', cellClassName: 'whitespace-nowrap font-mono text-xs' },
    { key: 'driver', label: 'Driver', cellClassName: 'whitespace-nowrap', render: (value: string | null) => value || <span className="text-slate-500 italic">Unassigned</span> },
    { key: 'conductor', label: 'Conductor', cellClassName: 'whitespace-nowrap', render: (value: string | null) => value || <span className="text-slate-500 italic">Unassigned</span> },
    {
      key: 'status',
      label: 'Status',
      cellClassName: 'whitespace-nowrap',
      render: (value: string) => {
        const color = value === 'Operating' ? 'text-emerald-400 admin-light:text-emerald-700'
          : value === 'Under Maintenance' ? 'text-amber-400 admin-light:text-amber-700'
          : value === 'Out of Service / Damaged' ? 'text-red-400 admin-light:text-red-600'
          : 'text-blue-400 admin-light:text-blue-700';
        return (
          <span className={`inline-flex items-center gap-2 ${color}`}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
            {value}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'center' as const,
      headerClassName: 'w-20',
      cellClassName: 'w-20',
      // Delete: the backend refuses with 409 while the unit is on an active
      // shift; the delete modal shows why.
      render: (_: unknown, row: Vehicle) => (
        <RowActionsMenu
          label={`Actions for ${row.plateNumber}`}
          actions={[
            // Same details view as double-clicking the row.
            ...(onRowDoubleClick ? [{ label: 'View Details', icon: Eye, onSelect: () => onRowDoubleClick(row) }] : []),
            { label: 'Shift History', icon: Clock, onSelect: () => onEditShift(row) },
            { label: 'Edit', icon: Pencil, onSelect: () => onEdit(row) },
            { label: 'Delete', icon: Trash2, onSelect: () => onDelete(row), tone: 'danger' },
          ]}
        />
      )
    },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white p-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
      <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SearchBar
          placeholder="Search vehicles..."
          value={searchQuery}
          onChange={onSearchChange}
          className="min-w-0 w-full lg:max-w-sm"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={onAddVehicle}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] sm:w-44"
          >
            <Plus size={18} />
            <span>Add Vehicle</span>
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg">
        {isLoading ? (
          <SkeletonTable rows={8} columns={6} />
        ) : (
          <DataTable
            data={vehicles}
            columns={columns}
            searchQuery=""
            emptyMessage="No vehicles match your search."
            height="100%"
            stickyHeader
            onRowDoubleClick={onRowDoubleClick}
          />
        )}
      </div>
      <div className="shrink-0">
        <TablePagination
          currentPage={page.currentPage}
          totalPages={page.totalPages}
          from={page.from}
          to={page.to}
          total={page.total}
          label="vehicles"
          onPageChange={onPageChange}
        />
      </div>
    </div>
  );
}
