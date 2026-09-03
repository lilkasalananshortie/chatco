// components/admin/vehicles/driver-detail-modal.tsx
'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/admin/ui/modal';
import { Badge } from '@/components/admin/ui/badge';
import {
  User,
  Phone,
  Car,
  Calendar,
  IdCard,
  MapPin,
  Users,
  Clock,
  FileText,
  RefreshCw,
} from 'lucide-react';
import type { Personnel } from '@/app/(admin)/vehicles/data/vehicles-data';

interface DriverDetail {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  birthday: string | null;
  contact: string;
  license_number: string;
  license_front_image_url: string | null;
  license_back_image_url: string | null;
  hire_date: string | null;
  profile_picture_url: string | null;
  status: string | null;
  vehicle: {
    id: string;
    unit_number: string;
    plate_number: string;
    route: string | null;
  } | null;
  conductor_partner: { id: string; name: string } | null;
  assigned_route: string;
  shift_logs: Array<{
    shift_id: string;
    unit_number: string | null;
    plate_number: string | null;
    route: string | null;
    time_in: string | null;
    time_out: string | null;
    status: string;
  }>;
}

interface DriverDetailModalProps {
  driver: Personnel | null;
  onClose: () => void;
}

function calculateAge(birthday: string | null): string {
  if (!birthday) return '—';
  try {
    const birth = new Date(birthday);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return `${age} years old`;
  } catch {
    return '—';
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-PH', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-PH', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return dateStr;
  }
}

export function DriverDetailModal({ driver, onClose }: DriverDetailModalProps) {
  const [details, setDetails] = useState<DriverDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetails = async () => {
    if (!driver) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/drivers/${driver.id}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? 'Failed to load driver details');
      }
      setDetails(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load driver details');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (driver) {
      fetchDetails();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver?.id]);

  if (!driver) return null;

  const fullName = details
    ? `${details.first_name} ${details.middle_name ? details.middle_name + ' ' : ''}${details.last_name}`.trim()
    : driver.name;

  const profilePic = details?.profile_picture_url
    ?? `https://placehold.co/150x150/0A1E33/62A0EA?text=${driver.name.charAt(0)}`;

  return (
    <Modal isOpen={!!driver} onClose={onClose} maxWidth="max-w-5xl">
      {/* ─── Header (full width) ─── */}
      <div className="flex items-start gap-4 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={profilePic}
          alt={fullName}
          className="w-20 h-20 rounded-xl border-2 border-[#62A0EA]/25 flex-shrink-0 object-cover"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-white truncate">{fullName}</h2>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-md bg-[#62A0EA]/15 text-[#62A0EA]">
              Driver
            </span>
            {details?.status && (
              <Badge variant={details.status === 'ACTIVE' ? 'success' : 'warning'}>
                {details.status}
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-slate-600 font-mono mt-1.5">
            ID: {driver.id.slice(0, 8)}…
          </p>
        </div>
        <button
          onClick={fetchDetails}
          disabled={isLoading}
          title="Refresh"
          className="p-2 text-slate-400 hover:text-white hover:bg-[#1A2540] rounded-md transition-colors flex-shrink-0"
        >
          <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md mb-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {isLoading && !details ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-14 bg-[#0E1628] border border-[#1E2D45] rounded-md animate-pulse" />
            ))}
          </div>
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 bg-[#0E1628] border border-[#1E2D45] rounded-md animate-pulse" />
            ))}
          </div>
        </div>
      ) : details ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* ═══════ LEFT COLUMN: Personal + Assignment Info ═══════ */}
          <div className="space-y-5">
            {/* ─── Personal Information ─── */}
            <div>
              <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2.5 flex items-center gap-2">
                <User size={13} />
                Personal Information
              </h3>
              <div className="space-y-2">
                {/* License Number */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <IdCard size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">License Number</p>
                    <p className="text-sm text-slate-300 truncate">{details.license_number || '—'}</p>
                  </div>
                </div>

                {/* License Images */}
                <div className="p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <div className="flex items-center gap-2 mb-2">
                    <IdCard size={16} className="text-slate-500" />
                    <p className="text-[10px] text-slate-600 uppercase">License Images</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      ['front', 'Front', details.license_front_image_url],
                      ['back', 'Back', details.license_back_image_url],
                    ] as const).map(([side, label, storedPath]) => (
                      <div key={side} className="min-w-0">
                        <div className="h-24 rounded border border-dashed border-[#2A3A55] flex items-center justify-center overflow-hidden bg-[#131C2E]">
                          {storedPath ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/api/admin/drivers/${details.id}/license-images/${side}`} alt={`${label} driver's license`} className="w-full h-full object-contain" />
                          ) : <span className="text-[11px] text-slate-600">Not uploaded</span>}
                        </div>
                        <p className="text-[10px] text-slate-500 text-center mt-1">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Birth Date + Age */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <Calendar size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Birth Date</p>
                    <p className="text-sm text-slate-300">{formatDate(details.birthday)}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[10px] text-slate-600 uppercase">Age</p>
                    <p className="text-sm text-slate-400">{calculateAge(details.birthday)}</p>
                  </div>
                </div>

                {/* Contact Number */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <Phone size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Contact Number</p>
                    <p className="text-sm text-slate-300">{details.contact || '—'}</p>
                  </div>
                </div>

                {/* Hire Date */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <Calendar size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Date Hired</p>
                    <p className="text-sm text-slate-300">{formatDate(details.hire_date)}</p>
                  </div>
                </div>

                {/* Fixed Route */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <MapPin size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Fixed Assigned Route</p>
                    <p className="text-sm text-slate-300">{details.assigned_route}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* ─── Assignment Information ─── */}
            <div>
              <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2.5 flex items-center gap-2">
                <Car size={13} />
                Assignment Information
              </h3>
              <div className="space-y-2">
                {/* Current Vehicle */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <Car size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Current Vehicle</p>
                    {details.vehicle ? (
                      <p className="text-sm text-slate-300">
                        {details.vehicle.unit_number} <span className="text-slate-500">({details.vehicle.plate_number})</span>
                      </p>
                    ) : (
                      <p className="text-sm text-slate-500 italic">Unassigned</p>
                    )}
                  </div>
                </div>

                {/* Current Conductor Partner */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <Users size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Current Conductor Partner</p>
                    {details.conductor_partner ? (
                      <p className="text-sm text-slate-300">{details.conductor_partner.name}</p>
                    ) : (
                      <p className="text-sm text-slate-500 italic">None</p>
                    )}
                  </div>
                </div>

                {/* Route Assignment */}
                <div className="flex items-center gap-3 p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                  <MapPin size={16} className="text-slate-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-slate-600 uppercase">Route Assignment</p>
                    <p className="text-sm text-slate-300">{details.vehicle?.route ?? details.assigned_route}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ═══════ RIGHT COLUMN: Assignment History ═══════ */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2.5 flex items-center gap-2">
              <Clock size={13} />
              Assignment History
              <span className="text-[10px] text-slate-600 font-normal normal-case tracking-normal">
                ({details.shift_logs.length} shifts)
              </span>
            </h3>
            {details.shift_logs.length === 0 ? (
              <div className="text-center py-10">
                <FileText size={32} className="text-slate-700 mx-auto mb-2" />
                <p className="text-xs text-slate-600 italic">No shift history yet.</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[min(56vh,520px)] overflow-y-auto pr-2 scrollbar-themed rounded-lg">
                {details.shift_logs.map((log) => (
                  <div key={log.shift_id} className="p-3 rounded-md bg-[#0E1628] border border-[#1E2D45]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-[#62A0EA]">
                        {log.unit_number || '—'}
                      </span>
                      <Badge variant={log.status === 'ACTIVE' ? 'success' : 'info'}>
                        {log.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-500">
                      <div>
                        <span className="text-slate-600">Plate:</span>{' '}
                        <span className="text-slate-400">{log.plate_number || '—'}</span>
                      </div>
                      <div>
                        <span className="text-slate-600">Route:</span>{' '}
                        <span className="text-slate-400">{log.route || '—'}</span>
                      </div>
                      <div>
                        <span className="text-slate-600">In:</span>{' '}
                        <span className="text-slate-400">{formatDateTime(log.time_in)}</span>
                      </div>
                      <div>
                        <span className="text-slate-600">Out:</span>{' '}
                        <span className="text-slate-400">{formatDateTime(log.time_out)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
