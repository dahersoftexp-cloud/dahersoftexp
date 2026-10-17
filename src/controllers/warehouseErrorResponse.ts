import { Response } from "express";
import { WarehouseError } from "../repositories/warehouseErrors";

export const sendWarehouseError = (res: Response, error: unknown) => {
  const failure =
    error instanceof WarehouseError
      ? error
      : new WarehouseError(503, "WAREHOUSE_WRITE_UNAVAILABLE");
  const messages: Record<string, string> = {
    INVALID_WAREHOUSE_INPUT: "تحقق من اسم المستودع والحقول المدخلة.",
    INVALID_WAREHOUSE_ID: "معرف المستودع غير صالح.",
    WAREHOUSE_ALREADY_EXISTS:
      "يوجد مستودع بهذا الاسم. راجع القائمة قبل إنشاء مستودع آخر.",
    WAREHOUSE_CONFLICT:
      "تغيّرت بيانات المستودع. حدّث القائمة ثم راجع تعديلاتك.",
    WAREHOUSE_IDENTITY_IMMUTABLE:
      "تغيير اسم المستودع أو نوعه يحتاج إجراء نقل مستقل.",
    WAREHOUSE_NOT_FOUND: "المستودع غير موجود.",
    VEHICLE_MANAGED_SEPARATELY: "عدّل هذا المستودع من صفحة السيارات.",
    INVALID_VEHICLE_DRIVER:
      "اختر مستخدماً نشطاً من هذه الشركة لربط السيارة به.",
    WAREHOUSE_WRITE_OUTCOME_UNKNOWN:
      "تعذر تأكيد نتيجة الحفظ. حدّث القائمة وتحقق من المستودع قبل إعادة المحاولة.",
    WAREHOUSE_WRITE_UNAVAILABLE:
      "تعذر الاتصال لحفظ المستودع. أعد المحاولة بعد التحقق من الاتصال.",
  };
  return res.status(failure.status).json({
    error: failure.code,
    message: messages[failure.code] || messages.WAREHOUSE_WRITE_UNAVAILABLE,
    ...(failure.warehouseId ? { warehouseId: failure.warehouseId } : {}),
  });
};
