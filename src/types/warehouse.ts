export interface Warehouse {
  id: string;
  name: string;
  location?: string;
  isActive: boolean;
  type?: "standard" | "vehicle";
  plateNumber?: string;
  driverId?: string;
  driverName?: string;
  defaultPaymentAccountId?: string;
  defaultReceivableAccountId?: string;
  defaultSalesAccountId?: string;
  createdDate: string;
  updatedDate: string;
  revision?: number;
  isArchived?: boolean;
  archivedAt?: string;
  driverAssignmentManaged?: boolean;
}
