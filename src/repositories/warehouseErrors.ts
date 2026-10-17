export class WarehouseError extends Error {
  constructor(
    public status: number,
    public code: string,
    public warehouseId?: string,
  ) {
    super(code);
  }
}
