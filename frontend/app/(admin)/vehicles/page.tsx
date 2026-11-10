// app/(admin)/vehicles/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { VehicleTable } from '@/components/admin/vehicles/vehicle-table';
import { AddVehicleModal } from '@/components/admin/vehicles/add-vehicle-modal';
import { EditVehicleModal } from '@/components/admin/vehicles/edit-vehicle-modal';
import { ShiftHistoryModal } from '@/components/admin/vehicles/shift-history-modal';
import { VehicleDetailsModal } from '@/components/admin/vehicles/vehicle-details-modal';
import { PersonnelTable } from '@/components/admin/vehicles/personnel-table';
import { AddPersonnelModal } from '@/components/admin/vehicles/add-personnel-modal';
import { EditPersonnelModal } from '@/components/admin/vehicles/edit-personnel-modal';
import { DeletePersonnelModal } from '@/components/admin/vehicles/delete-personnel-modal';
import { CreateConductorAccountModal } from '@/components/admin/vehicles/create-conductor-account-modal';
import { ConductorAccountSuccessModal } from '@/components/admin/vehicles/conductor-account-success-modal';
import { DeleteVehicleModal } from '@/components/admin/vehicles/delete-vehicle-modal';
import { OperationResultModal } from '@/components/admin/ui/operation-result-modal';
import { remove as removeVehicle } from '@/lib/admin/services/vehicle.service';
import { Users, AlertCircle, RefreshCw } from 'lucide-react';
import { JeepneyIcon } from '@/config/admin-nav';
import { useVehiclesData } from './data/vehicles-data';
import type { VehiclesQueryState, PersonnelRoleFilter, PersonnelStatusFilter, Vehicle, Personnel } from './data/vehicles-data';
import { StickyPageHeader } from '@/components/admin/layout/sticky-page-header';
import { PageTabs } from '@/components/admin/ui/page-tabs';

export default function VehiclesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false);
  const [isEditVehicleModalOpen, setIsEditVehicleModalOpen] = useState(false);
  const [isPersonnelModalOpen, setIsPersonnelModalOpen] = useState(false);
  const [isEditPersonnelOpen, setIsEditPersonnelOpen] = useState(false);
  const [isDeletePersonnelOpen, setIsDeletePersonnelOpen] = useState(false);
  const [isShiftHistoryOpen, setIsShiftHistoryOpen] = useState(false);
  const [isCreateConductorOpen, setIsCreateConductorOpen] = useState(false);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);
  
  const [createdAccountData, setCreatedAccountData] = useState<{
    id: string;
    first_name: string;
    last_name: string;
    generated_username: string;
    generated_password: string;
  } | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [deletingVehicle, setDeletingVehicle] = useState<Vehicle | null>(null);
  const [vehicleDeletedMessage, setVehicleDeletedMessage] = useState<string | null>(null);
  const [shiftHistoryVehicle, setShiftHistoryVehicle] = useState<Vehicle | null>(null);
  /** id of the vehicle whose details + permanent QR modal is open. null = closed. */
  const [detailsVehicleId, setDetailsVehicleId] = useState<string | null>(null);
  const [editingPersonnelData, setEditingPersonnelData] = useState<Personnel | null>(null);
  const [deletingPersonnelData, setDeletingPersonnelData] = useState<Personnel | null>(null);
  
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'vehicles' | 'personnel'>('vehicles');
  const [personnelRole, setPersonnelRole] = useState<PersonnelRoleFilter>('all');
  const [personnelStatus, setPersonnelStatus] = useState<PersonnelStatusFilter>('ACTIVE');
  const [vehiclePage, setVehiclePage] = useState(1);
  const [personnelPage, setPersonnelPage] = useState(1);

  const queryState = useMemo<VehiclesQueryState>(() => ({
    activeTab,
    historyTab: 'shifts',
    searchQuery,
    personnelRole,
    personnelStatus,
    shiftHistoryRange: 'today',
    vehiclePage,
    personnelPage,
    terminatedPage: 1,
    shiftPage: 1,
  }), [activeTab, searchQuery, personnelRole, personnelStatus, vehiclePage, personnelPage]);

  const { data, counts, pages, isLoading, error, refetch } = useVehiclesData(queryState);
  
  const vehicles = data.vehicles;

  useEffect(() => {
    const id = window.setTimeout(() => {
      setSearchQuery(searchInput);
      setVehiclePage(1);
      setPersonnelPage(1);
    }, 350);

    return () => window.clearTimeout(id);
  }, [searchInput]);

  // ─── Deep-link from the notification bell ──────────────────────
  // A SHIFT_STARTED notification links here as /vehicles?vehicleId={id}.
  // VehicleDetailsModal already fetches by id on its own, so there's no
  // list to search — just open it directly. Runs once on mount; the param
  // is stripped from the URL right after so a refresh/back doesn't reopen it.
  useEffect(() => {
    const vehicleId = searchParams.get('vehicleId');
    if (!vehicleId) return;
    setDetailsVehicleId(vehicleId);
    router.replace('/vehicles');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only: reacting to `router`/`searchParams` would re-fire after router.replace() strips the param.
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
  };

  const handlePersonnelRoleChange = (role: PersonnelRoleFilter) => {
    setPersonnelRole(role);
    setPersonnelPage(1);
  };

  const handlePersonnelStatusChange = (status: PersonnelStatusFilter) => {
    setPersonnelStatus(status);
    setPersonnelPage(1);
  };

  const tabs = [
    { id: 'vehicles' as const, label: 'Vehicles', count: counts.vehicles, icon: JeepneyIcon },
    { id: 'personnel' as const, label: 'Personnel', count: counts.personnel, icon: Users },
  ];

  // ─── Error State ───
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertCircle size={40} className="text-red-400 admin-light:text-red-600" />
        <p className="text-slate-300 admin-light:text-slate-700 text-center">Failed to load fleet data.</p>
        <p className="text-slate-500 text-sm text-center">{error}</p>
        <button
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 bg-[#62A0EA] admin-light:bg-[#1A5FB4] text-white rounded-md hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] transition-colors"
        >
          <RefreshCw size={16} />
          Retry
        </button>
      </div>
    );
  }

  // Double-click a vehicle row → open the details modal (vehicle info +
  // today's driver/conductor + the permanent, printable unit QR).
  const handleOpenDetails = (vehicle: Vehicle) => { setDetailsVehicleId(vehicle.id); };
  const handleCloseDetails = () => { setDetailsVehicleId(null); };

  // Vehicle Handlers
  const handleOpenVehicleModal = () => setIsVehicleModalOpen(true);
  const handleCloseVehicleModal = () => setIsVehicleModalOpen(false);
  const handleOpenEditModal = (vehicle: Vehicle) => { setEditingVehicle(vehicle); setIsEditVehicleModalOpen(true); };
  const handleCloseEditModal = () => { setEditingVehicle(null); setIsEditVehicleModalOpen(false); };
  const handleSaveVehicle = (createdVehicleId: string) => {
    // Close the Add modal first, refresh the table, then surface the new
    // unit's permanent QR so the admin can download/print it immediately.
    handleCloseVehicleModal();
    refetch();
    if (createdVehicleId) setDetailsVehicleId(createdVehicleId);
  };

  // After PUT succeeds — the EditVehicleModal calls onSaved() which triggers this.
  // We refetch from the API to get the canonical record with fresh relationships.
  const handleVehicleUpdated = () => { refetch(); handleCloseEditModal(); };

  // Delete — the modal awaits this and shows a thrown error (e.g. the 409
  // active-shift conflict) inline, staying open; on success it closes.
  const handleOpenDeleteVehicle = (vehicle: Vehicle) => { setDeletingVehicle(vehicle); };
  const handleCloseDeleteVehicle = () => { setDeletingVehicle(null); };
  const handleConfirmDeleteVehicle = async () => {
    if (!deletingVehicle) return;
    await removeVehicle(deletingVehicle.id);
    setVehicleDeletedMessage(`Vehicle deleted successfully. Unit ${deletingVehicle.unitNumber} (${deletingVehicle.plateNumber}) was removed from the fleet.`);
    refetch();
  };

  // Shift History Handlers — opens the modal that fetches /api/admin/shift-logs?vehicle_id=
  const handleOpenShiftHistory = (vehicle: Vehicle) => { setShiftHistoryVehicle(vehicle); setIsShiftHistoryOpen(true); };
  const handleCloseShiftHistory = () => { setShiftHistoryVehicle(null); setIsShiftHistoryOpen(false); };

  // Personnel Handlers
  const handleOpenPersonnelModal = () => setIsPersonnelModalOpen(true);
  const handleClosePersonnelModal = () => setIsPersonnelModalOpen(false);
  
  const handleOpenEditPersonnel = (personnel: Personnel) => {
    setEditingPersonnelData(personnel);
    setIsEditPersonnelOpen(true);
  };
  const handleCloseEditPersonnel = () => {
    setEditingPersonnelData(null);
    setIsEditPersonnelOpen(false);
  };
  const handleSaveEditPersonnel = () => {
    // Modal calls real PUT /api/admin/drivers/{id} and triggers this onSaved()
    // callback on success. We refetch from the API to get the canonical record.
    refetch();
    handleCloseEditPersonnel();
  };

  const handleOpenDeletePersonnel = (personnel: Personnel) => {
    setDeletingPersonnelData(personnel);
    setIsDeletePersonnelOpen(true);
  };
  const handleCloseDeletePersonnel = () => {
    setDeletingPersonnelData(null);
    setIsDeletePersonnelOpen(false);
  };
  const handleConfirmDeletePersonnel = async (deleteData: { id: string; reason: string; terminationType: string }): Promise<void> => {
    const person = deletingPersonnelData?.id === deleteData.id
      ? deletingPersonnelData
      : data.personnel.find(p => p.id === deleteData.id);
    if (!person) {
      throw new Error('Personnel not found. They may have already been removed.');
    }

    // Drivers → DELETE /api/admin/drivers/{id}
    // Conductors → DELETE /api/admin/conductors/{id} (separate from the
    // generic /admin/users/{id} because this flow persists the termination
    // reason + type to the terminated_personnel table).
    //
    // The modal's terminationType is 'Terminated' | 'Resigned' (UI labels).
    // The backend expects 'TERMINATED' | 'RESIGNED' (enum values). Convert.
    const endpoint = person.role === 'Driver'
      ? `/api/admin/drivers/${deleteData.id}`
      : `/api/admin/conductors/${deleteData.id}`;

    const terminationType = deleteData.terminationType === 'Resigned' ? 'RESIGNED' : 'TERMINATED';

    const res = await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        reason: deleteData.reason,
        termination_type: terminationType,
      }),
    });

    if (!res.ok) {
      let message = `Failed to remove ${person.role.toLowerCase()} (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        // 409 conflict (active shift) → use the backend's specific message.
        // 422 validation error → surface the first field error.
        // Other errors → use the backend's message field if available.
        if (res.status === 409) {
          message = body?.message ?? `Cannot remove this ${person.role.toLowerCase()} — they may be on an active shift. End the shift first.`;
        } else if (res.status === 422 && body?.errors) {
          const firstField = Object.keys(body.errors)[0];
          const firstError = firstField ? body.errors[firstField]?.[0] : null;
          message = firstError ?? body?.message ?? message;
        } else if (body?.message) {
          message = body.message;
        }
      } catch {
        // Response wasn't JSON — keep the default HTTP-status message.
      }
      throw new Error(message);
    }

    // Success — refetch the canonical list from the API so the personnel
    // array reflects the soft-deletion AND the terminated_personnel table
    // gains the new row (both are fetched in fetchVehiclesData).
    await refetch();
  };

  // Add Personnel Handler — modal calls real POST /api/admin/drivers and
  // triggers this onSave() callback on success. We refetch from the API to
  // get the canonical record with the auto-generated UUID + relationships.
  const handleSaveNewPersonnel = () => {
    refetch();
    handleClosePersonnelModal();
  };

  // Shift & Conductor Handlers
  const handleOpenCreateConductor = () => setIsCreateConductorOpen(true);
  const handleCloseCreateConductor = () => setIsCreateConductorOpen(false);
  // Called by the modal after POST /api/admin/conductors succeeds — receives
  // the real generated credentials from the backend, shows the success modal,
  // and refetches the personnel list so the new conductor appears.
  const handleConductorCreated = (account: {
    id: string;
    first_name: string;
    last_name: string;
    generated_username: string;
    generated_password: string;
  }) => {
    setCreatedAccountData(account);
    setIsSuccessModalOpen(true);
    handleCloseCreateConductor();
    refetch();
  };
  const handleCloseSuccessModal = () => { setIsSuccessModalOpen(false); setCreatedAccountData(null); };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StickyPageHeader className="mb-3 shrink-0">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-white admin-light:text-slate-900">Fleet Management</h1>
        </div>
      </StickyPageHeader>

      {/* Tab Navigation */}
      <PageTabs tabs={tabs} activeId={activeTab} onChange={setActiveTab} className="mb-3" />

      {/* Tab Content */}
      {activeTab === 'vehicles' ? (
        <VehicleTable
          vehicles={vehicles}
          searchQuery={searchInput}
          page={pages.vehicles}
          onPageChange={setVehiclePage}
          onSearchChange={handleSearchChange}
          onAddVehicle={handleOpenVehicleModal}
          onEdit={handleOpenEditModal}
          onEditShift={handleOpenShiftHistory}
          onDelete={handleOpenDeleteVehicle}
          onRowDoubleClick={handleOpenDetails}
          isLoading={isLoading}
        />
      ) : (
        <PersonnelTable 
          personnel={data.personnel}
          searchQuery={searchInput} 
          roleFilter={personnelRole}
          statusFilter={personnelStatus}
          page={pages.personnel}
          onPageChange={setPersonnelPage}
          onSearchChange={handleSearchChange}
          onRoleFilterChange={handlePersonnelRoleChange}
          onStatusFilterChange={handlePersonnelStatusChange}
          onAddDriver={handleOpenPersonnelModal}
          onCreateConductor={handleOpenCreateConductor}
          onEdit={handleOpenEditPersonnel}
          onDelete={handleOpenDeletePersonnel}
          onPersonnelChanged={refetch}
          driverProfiles={data.driverProfiles}
          driverRatings={data.driverRatings}
          isLoading={isLoading}
        />
      )}

      {/* All Modals */}
      <AddVehicleModal isOpen={isVehicleModalOpen} onClose={handleCloseVehicleModal} onSave={handleSaveVehicle} />
      <EditVehicleModal
        isOpen={isEditVehicleModalOpen}
        onClose={handleCloseEditModal}
        onSaved={handleVehicleUpdated}
        editingVehicle={editingVehicle}
      />
      <ShiftHistoryModal
        isOpen={isShiftHistoryOpen}
        onClose={handleCloseShiftHistory}
        vehicle={shiftHistoryVehicle}
      />
      <VehicleDetailsModal
        isOpen={detailsVehicleId !== null}
        vehicleId={detailsVehicleId}
        onClose={handleCloseDetails}
      />
      <AddPersonnelModal isOpen={isPersonnelModalOpen} onClose={handleClosePersonnelModal} onSave={handleSaveNewPersonnel} />
      <EditPersonnelModal isOpen={isEditPersonnelOpen} onClose={handleCloseEditPersonnel} onSaved={handleSaveEditPersonnel} editingData={editingPersonnelData} />
      <DeletePersonnelModal isOpen={isDeletePersonnelOpen} onClose={handleCloseDeletePersonnel} onConfirm={handleConfirmDeletePersonnel} personnelData={deletingPersonnelData} />

      <CreateConductorAccountModal isOpen={isCreateConductorOpen} onClose={handleCloseCreateConductor} onCreated={handleConductorCreated} />
      <ConductorAccountSuccessModal isOpen={isSuccessModalOpen} onClose={handleCloseSuccessModal} accountData={createdAccountData} />
      <DeleteVehicleModal
        key={deletingVehicle?.id ?? 'closed-delete-vehicle'}
        isOpen={deletingVehicle !== null}
        onClose={handleCloseDeleteVehicle}
        onConfirm={handleConfirmDeleteVehicle}
        vehicle={deletingVehicle}
      />
      <OperationResultModal
        isOpen={vehicleDeletedMessage !== null}
        type="success"
        title="Vehicle deleted"
        message={vehicleDeletedMessage ?? ''}
        onClose={() => setVehicleDeletedMessage(null)}
      />
    </div>
  );
}
