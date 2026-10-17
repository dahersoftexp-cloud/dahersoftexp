export interface InventoryUser {
  id?: string;
  username: string;
  password?: string;
  passwordHash?: string;
  identityId?: string;
  sessionVersion?: string;
  tenantId?: string;
  status?: string;
  role: string;
  permissions?: string[];
  vehicleId?: string;
  vehicleName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InventoryUserResponse {
  id: string;
  username: string;
  status?: string;
  role: string;
  permissions: string[];
  vehicleId?: string;
  vehicleName?: string;
  createdAt?: string;
  updatedAt?: string;
}
