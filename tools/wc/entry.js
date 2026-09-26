// Browser bundle for Bark Arena: WalletConnect sign client + QR codes.
export { SignClient } from "@walletconnect/sign-client";
import QRCode from "qrcode";
export const qrDataUrl = (text) => QRCode.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: "M" });
