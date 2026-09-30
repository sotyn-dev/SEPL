import React, { useState, useEffect, useMemo } from 'react';
import {
  FiPlus, FiSearch, FiFilter, FiCheckCircle, FiXCircle, FiClock,
  FiFileText, FiTruck, FiLayers, FiDollarSign, FiAlertTriangle,
  FiUploadCloud, FiEye, FiPrinter, FiEdit3, FiRefreshCw, FiChevronRight,
  FiPackage, FiShield, FiArrowRight, FiInfo, FiCheck, FiX, FiLink, FiPaperclip,
  FiBox, FiActivity, FiHelpCircle, FiLock, FiTrash2, FiLoader, FiZap,
  FiDownload, FiExternalLink, FiImage, FiCamera, FiMaximize2
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';

function parsePhotos(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (_) {}
    if (val.startsWith('/uploads') || val.startsWith('http')) {
      return val.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function isPdfUrl(url) {
  return typeof url === 'string' && (/\.pdf($|\?)/i.test(url) || url.includes('/pdf'));
}

export default function SiteGRN() {
  const { user, canCreate, canEdit, canApprove, isAdmin } = useAuth();

  // Role permissions
  const canCreateGRN = isAdmin() || canCreate('site_grn') || canCreate('procurement') || canCreate('inventory');
  const canVerifyGRN = isAdmin() || canEdit('site_grn') || canEdit('procurement') || canApprove('dpr');
  const canApproveGRN = isAdmin() || canApprove('site_grn') || canApprove('procurement');
  const canManageInvoices = isAdmin() || canCreate('billing') || canApprove('billing') || canApprove('site_grn') || user?.department === 'Accounts';
  const canProcessPayment = isAdmin() || canApprove('payment_required') || canApprove('site_grn') || user?.department === 'Finance';

  // Active Tab: 'grn_list' | 'invoices' | 'payments'
  const [activeTab, setActiveTab] = useState('grn_list');

  // Metrics
  const [metrics, setMetrics] = useState({
    totalGrn: 0,
    pendingGrnVerify: 0,
    approvedGrn: 0,
    totalInvoices: 0,
    pendingInvoiceApprove: 0,
    exceptionInvoices: 0,
    approvedInvoicesPendingPay: 0,
    totalPaidCount: 0,
    totalPaidAmount: 0
  });

  // Lookups
  const [sites, setSites] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [availablePos, setAvailablePos] = useState([]);

  // GRN State
  const [grnList, setGrnList] = useState([]);
  const [grnLoading, setGrnLoading] = useState(false);
  const [grnFilters, setGrnFilters] = useState({
    site_id: '',
    vendor_id: '',
    po_number: '',
    status: 'all',
    search: '',
    from_date: '',
    to_date: ''
  });

  // Drawer / Modals
  const [selectedGrn, setSelectedGrn] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingGrnId, setEditingGrnId] = useState(null);
  const [poLoading, setPoLoading] = useState(false);
  const [submittingGrn, setSubmittingGrn] = useState(false);
  const [parsingChallan, setParsingChallan] = useState(false);

  // Form State
  const [grnForm, setGrnForm] = useState({
    vendor_po_id: '',
    po_number: '',
    vendor_id: '',
    vendor_name: '',
    site_id: '',
    site_name: '',
    warehouse_id: '',
    warehouse_name: '',
    delivery_challan_no: '',
    challan_date: new Date().toISOString().slice(0, 10),
    vehicle_number: '',
    remarks: '',
    challan_doc_url: '',
    material_photos: [],
    items: []
  });

  // Action Modals (Verify / Approve / Reject / Correction)
  const [actionModal, setActionModal] = useState({
    isOpen: false,
    grnId: null,
    type: '',
    reason: '',
    remarks: ''
  });
  const [actionLoading, setActionLoading] = useState(false);

  // Photo Lightbox & Quick Attach State
  const [previewImage, setPreviewImage] = useState(null);
  const [quickAttachModal, setQuickAttachModal] = useState({
    isOpen: false,
    grn: null,
    uploading: false,
    challan_doc_url: '',
    material_photos: []
  });

  // Invoices State
  const [invoiceList, setInvoiceList] = useState([]);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceFilters, setInvoiceFilters] = useState({
    status: 'all',
    match_status: 'all',
    search: '',
    vendor_id: ''
  });
  const [showCreateInvoiceModal, setShowCreateInvoiceModal] = useState(false);
  const [selectedApprovedGrnId, setSelectedApprovedGrnId] = useState('');
  const [invoiceGrnData, setInvoiceGrnData] = useState(null);
  const [invoiceForm, setInvoiceForm] = useState({
    invoice_number: '',
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: '',
    attachment_url: '',
    remarks: '',
    items: []
  });
  const [submittingInvoice, setSubmittingInvoice] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [exceptionModal, setExceptionModal] = useState({
    isOpen: false,
    invoiceId: null,
    resolution_notes: ''
  });

  // Payments State
  const [pendingPaymentInvoices, setPendingPaymentInvoices] = useState([]);
  const [paymentList, setPaymentList] = useState([]);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentModal, setPaymentModal] = useState({
    isOpen: false,
    invoice: null,
    payment_date: new Date().toISOString().slice(0, 10),
    payment_mode: 'NEFT/RTGS',
    bank_reference: '',
    bank_name: 'HDFC Bank - Primary',
    tds_deduction: 0,
    other_deductions: 0,
    deduction_reason: '',
    payment_proof_url: '',
    payment_remarks: ''
  });
  const [processingPayment, setProcessingPayment] = useState(false);

  // Notifications
  const [notification, setNotification] = useState(null);
  const showToast = (msg, type = 'success') => {
    if (type === 'error') toast.error(msg, { duration: 4000 });
    else toast.success(msg, { duration: 4000 });
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  };

  useEffect(() => {
    fetchMetrics();
    fetchLookups();
    fetchGrnList();
  }, []);

  useEffect(() => {
    if (activeTab === 'grn_list') fetchGrnList();
  }, [activeTab, grnFilters]);

  useEffect(() => {
    if (activeTab === 'invoices') fetchInvoices();
  }, [activeTab, invoiceFilters]);

  useEffect(() => {
    if (activeTab === 'payments') fetchPaymentsData();
  }, [activeTab]);

  const fetchMetrics = async () => {
    try {
      const res = await api.get('/site-grn/metrics');
      if (res.data) setMetrics(res.data);
    } catch (e) { console.error(e); }
  };

  const fetchLookups = async () => {
    try {
      const [swRes, poRes] = await Promise.all([
        api.get('/site-grn/lookup/sites-warehouses'),
        api.get('/site-grn/lookup/pos')
      ]);
      if (swRes.data) {
        setSites(swRes.data.sites || []);
        setWarehouses(swRes.data.warehouses || []);
        setVendors(swRes.data.vendors || []);
      }
      if (poRes.data) setAvailablePos(poRes.data || []);
    } catch (e) { console.error(e); }
  };

  const fetchGrnList = async () => {
    setGrnLoading(true);
    try {
      const q = new URLSearchParams();
      Object.entries(grnFilters).forEach(([k, v]) => {
        if (v && v !== 'all') q.append(k, v);
      });
      const res = await api.get(`/site-grn/grn?${q.toString()}`);
      if (res.data) setGrnList(res.data);
    } catch (e) { console.error(e); }
    finally { setGrnLoading(false); }
  };

  const fetchInvoices = async () => {
    setInvoiceLoading(true);
    try {
      const q = new URLSearchParams();
      Object.entries(invoiceFilters).forEach(([k, v]) => {
        if (v && v !== 'all') q.append(k, v);
      });
      const res = await api.get(`/site-grn/invoices?${q.toString()}`);
      if (res.data) setInvoiceList(res.data);
    } catch (e) { console.error(e); }
    finally { setInvoiceLoading(false); }
  };

  const fetchPaymentsData = async () => {
    setPaymentLoading(true);
    try {
      const [pendingRes, paidRes] = await Promise.all([
        api.get('/site-grn/payments/pending-invoices'),
        api.get('/site-grn/payments')
      ]);
      if (pendingRes.data) setPendingPaymentInvoices(pendingRes.data);
      if (paidRes.data) setPaymentList(paidRes.data);
    } catch (e) { console.error(e); }
    finally { setPaymentLoading(false); }
  };

  // PO Selection in GRN Modal
  const handlePoSelect = async (poId) => {
    if (!poId) {
      setGrnForm(prev => ({ ...prev, vendor_po_id: '', po_number: '' }));
      return;
    }
    setPoLoading(true);
    try {
      const res = await api.get(`/site-grn/lookup/po-items/${poId}`);
      if (res.data) {
        const data = res.data;
        const po = data.po;
        const wh = data.warehouse;
        const st = data.site;
        const dn = data.delivery_note;

        setGrnForm(prev => ({
          ...prev,
          vendor_po_id: po.id,
          po_number: po.po_number,
          vendor_id: po.vendor_id || '',
          vendor_name: po.vendor_name || '',
          site_id: st?.id || po.site_id || '',
          site_name: st?.name || po.site_name || '',
          warehouse_id: wh?.id || '',
          warehouse_name: wh?.name || '',
          delivery_challan_no: prev.delivery_challan_no || dn?.document_number || `DC/${new Date().getFullYear()}/${String(po.id).padStart(4, '0')}`,
          challan_date: prev.challan_date || dn?.delivery_date || new Date().toISOString().slice(0, 10),
          vehicle_number: prev.vehicle_number || dn?.vehicle_no || '',
          challan_doc_url: prev.challan_doc_url || dn?.challan_doc_url || '',
          remarks: prev.remarks || dn?.notes || '',
          items: (data.items || []).map(it => ({
            item_master_id: it.item_master_id || null,
            item_code: it.item_code || '',
            material_name: it.material_name || '',
            unit: it.unit || 'nos',
            po_qty: Number(it.po_qty || 0),
            prev_received_qty: Number(it.prev_received_qty || 0),
            remaining_balance: Number(it.remaining_balance || 0),
            curr_received_qty: Number(it.remaining_balance || 0),
            accepted_qty: Number(it.remaining_balance || 0),
            rejected_qty: 0,
            unit_rate: Number(it.unit_rate || 0),
            tax_rate: Number(it.tax_rate || 18),
            rejection_reason: '',
            remarks: ''
          }))
        }));

        if (dn?.challan_doc_url) {
          showToast('⚡ PO details & Dispatch Challan photo auto-populated!');
        }
      }
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
    finally { setPoLoading(false); }
  };

  const handleAddManualItem = () => {
    setGrnForm(prev => ({
      ...prev,
      items: [
        ...prev.items,
        {
          item_master_id: null,
          item_code: '',
          material_name: '',
          unit: 'nos',
          po_qty: 0,
          prev_received_qty: 0,
          remaining_balance: 0,
          curr_received_qty: 1,
          accepted_qty: 1,
          rejected_qty: 0,
          unit_rate: 0,
          tax_rate: 18,
          rejection_reason: '',
          remarks: '',
          is_manual: true
        }
      ]
    }));
  };

  const handleRemoveGrnItem = (idx) => {
    setGrnForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== idx)
    }));
  };

  const updateGrnItemQty = (index, field, value) => {
    setGrnForm(prev => {
      const newItems = [...prev.items];
      const item = { ...newItems[index] };
      const numVal = Math.max(0, parseFloat(value) || 0);

      if (field === 'curr_received_qty') {
        item.curr_received_qty = numVal;
        item.accepted_qty = Math.max(0, numVal - (item.rejected_qty || 0));
      } else if (field === 'accepted_qty') {
        item.accepted_qty = numVal;
        item.rejected_qty = Math.max(0, (item.curr_received_qty || 0) - numVal);
      } else if (field === 'rejected_qty') {
        item.rejected_qty = numVal;
        item.accepted_qty = Math.max(0, (item.curr_received_qty || 0) - numVal);
      } else {
        item[field] = value;
      }

      newItems[index] = item;
      return { ...prev, items: newItems };
    });
  };

  const handleAcceptItem = (index) => {
    setGrnForm(prev => {
      const newItems = [...prev.items];
      const item = { ...newItems[index] };
      const curr = Math.max(0, parseFloat(item.curr_received_qty) || 0);
      item.accepted_qty = curr;
      item.rejected_qty = 0;
      item.rejection_reason = '';
      newItems[index] = item;
      return { ...prev, items: newItems };
    });
  };

  const handleRejectItem = (index) => {
    setGrnForm(prev => {
      const newItems = [...prev.items];
      const item = { ...newItems[index] };
      const curr = Math.max(0, parseFloat(item.curr_received_qty) || 0);
      item.accepted_qty = 0;
      item.rejected_qty = curr;
      newItems[index] = item;
      return { ...prev, items: newItems };
    });
  };

  const handleAcceptAllItems = () => {
    setGrnForm(prev => ({
      ...prev,
      items: prev.items.map(it => {
        const curr = Math.max(0, parseFloat(it.curr_received_qty) || 0);
        return {
          ...it,
          accepted_qty: curr,
          rejected_qty: 0,
          rejection_reason: ''
        };
      })
    }));
    showToast('All items marked as Accepted');
  };

  const handleRejectAllItems = () => {
    setGrnForm(prev => ({
      ...prev,
      items: prev.items.map(it => {
        const curr = Math.max(0, parseFloat(it.curr_received_qty) || 0);
        return {
          ...it,
          accepted_qty: 0,
          rejected_qty: curr
        };
      })
    }));
    showToast('All items marked as Rejected', 'error');
  };

  const handleFileUpload = async (e, fieldType) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    if (fieldType === 'challan') {
      setParsingChallan(true);
      try {
        const res = await api.post('/site-grn/parse-challan', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        if (res.data && res.data.success) {
          const { file_url, parsed, ai_parsed, ai_error } = res.data;
          setGrnForm(prev => {
            const next = { ...prev, challan_doc_url: file_url };
            if (parsed.delivery_challan_no) next.delivery_challan_no = parsed.delivery_challan_no;
            if (parsed.challan_date) next.challan_date = parsed.challan_date;
            if (parsed.vehicle_number) next.vehicle_number = parsed.vehicle_number;
            if (parsed.vendor_id) next.vendor_id = parsed.vendor_id;
            if (parsed.vendor_name) next.vendor_name = parsed.vendor_name;
            if (parsed.vendor_po_id) next.vendor_po_id = parsed.vendor_po_id;
            if (parsed.po_number) next.po_number = parsed.po_number;
            if (parsed.site_id) next.site_id = parsed.site_id;
            if (parsed.site_name) next.site_name = parsed.site_name;
            if (parsed.warehouse_id) next.warehouse_id = parsed.warehouse_id;
            if (parsed.warehouse_name) next.warehouse_name = parsed.warehouse_name;
            if (parsed.remarks && !prev.remarks) next.remarks = parsed.remarks;
            if (Array.isArray(parsed.items) && parsed.items.length > 0) {
              next.items = parsed.items;
            }
            return next;
          });

          const count = parsed?.items?.length || 0;
          if (ai_parsed && count > 0) {
            showToast(`⚡ Challan scanned & auto-filled! Vendor: ${parsed.vendor_name || 'Detected'}, ${count} items populated.`);
          } else if (ai_error) {
            showToast(`Document uploaded, but AI Notice: ${ai_error}`, 'error');
          } else {
            showToast(`Challan uploaded! ${count} items loaded.`);
          }
        }
      } catch (err) {
        showToast(err?.response?.data?.error || 'Failed to scan challan: ' + err.message, 'error');
      } finally {
        setParsingChallan(false);
      }
      return;
    }

    try {
      const res = await api.post('/site-grn/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      if (res.data) {
        const data = res.data;
        if (fieldType === 'photo') setGrnForm(prev => ({ ...prev, material_photos: [...(prev.material_photos || []), data.url] }));
        else if (fieldType === 'invoice_doc') setInvoiceForm(prev => ({ ...prev, attachment_url: data.url }));
        else if (fieldType === 'payment_proof') setPaymentModal(prev => ({ ...prev, payment_proof_url: data.url }));
        showToast('Document uploaded successfully!');
      }
    } catch (err) { showToast(err?.response?.data?.error || err.message, 'error'); }
  };

  const handleQuickFileUpload = async (e, type) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await api.post('/site-grn/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      if (res.data?.url) {
        if (type === 'challan') {
          setQuickAttachModal(prev => ({ ...prev, challan_doc_url: res.data.url }));
        } else {
          setQuickAttachModal(prev => ({ ...prev, material_photos: [...(prev.material_photos || []), res.data.url] }));
        }
        showToast('Photo uploaded!');
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    }
  };

  const handleSaveQuickPhotos = async () => {
    if (!quickAttachModal.grn) return;
    setQuickAttachModal(prev => ({ ...prev, uploading: true }));
    try {
      const res = await api.post(`/site-grn/grn/${quickAttachModal.grn.id}/attach-photos`, {
        challan_doc_url: quickAttachModal.challan_doc_url,
        material_photos: quickAttachModal.material_photos
      });
      if (res.data?.success) {
        showToast('Challan & material photos saved!');
        setGrnList(prev => prev.map(g => g.id === quickAttachModal.grn.id ? {
          ...g,
          challan_doc_url: res.data.challan_doc_url,
          material_photos: res.data.material_photos
        } : g));
        if (selectedGrn && selectedGrn.id === quickAttachModal.grn.id) {
          setSelectedGrn(prev => ({
            ...prev,
            challan_doc_url: res.data.challan_doc_url,
            material_photos: res.data.material_photos
          }));
        }
        setQuickAttachModal({ isOpen: false, grn: null, uploading: false, challan_doc_url: '', material_photos: [] });
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message, 'error');
    } finally {
      setQuickAttachModal(prev => ({ ...prev, uploading: false }));
    }
  };

  const handleSaveGrn = async (isSubmit = false) => {
    if (!grnForm.delivery_challan_no?.trim()) {
      showToast('Delivery Challan Number is required', 'error');
      return;
    }
    if (!grnForm.items.length) {
      showToast('Please add at least one material line item', 'error');
      return;
    }

    for (const it of grnForm.items) {
      if (!it.material_name || !String(it.material_name).trim()) {
        showToast('Please enter Material Description for all items', 'error');
        return;
      }
      const curr = Number(it.curr_received_qty || 0);
      const acc = Number(it.accepted_qty || 0);
      const rej = Number(it.rejected_qty || 0);

      if (curr <= 0) {
        showToast(`Received Quantity must be greater than 0 for "${it.material_name}"`, 'error');
        return;
      }
      if (Math.abs((acc + rej) - curr) > 0.001) {
        showToast(`Validation Error for "${it.material_name}": Accepted (${acc}) + Rejected (${rej}) must equal Received (${curr})`, 'error');
        return;
      }
      if (rej > 0 && !it.rejection_reason?.trim()) {
        showToast(`Rejection reason is mandatory for item "${it.material_name}" (Rejected: ${rej})`, 'error');
        return;
      }
    }

    setSubmittingGrn(true);
    try {
      const endpoint = editingGrnId ? `/site-grn/grn/${editingGrnId}` : '/site-grn/grn';
      const res = editingGrnId
        ? await api.put(endpoint, { ...grnForm, is_submit: isSubmit })
        : await api.post(endpoint, { ...grnForm, is_submit: isSubmit });

      showToast(res.data?.message || 'GRN saved successfully!');
      setShowCreateModal(false);
      setEditingGrnId(null);
      fetchGrnList();
      fetchMetrics();
    } catch (e) {
      showToast(e?.response?.data?.error || e.message, 'error');
    } finally {
      setSubmittingGrn(false);
    }
  };

  const handleGrnAction = async () => {
    const { grnId, invoiceId, type, reason, remarks } = actionModal;
    if (!type) return;

    if ((type === 'reject' || type === 'correction' || type === 'reject_invoice') && !reason.trim()) {
      showToast('Reason is required', 'error');
      return;
    }

    setActionLoading(true);
    try {
      let res;
      if (type === 'verify') {
        res = await api.post(`/site-grn/grn/${grnId}/verify`, { remarks });
      } else if (type === 'approve') {
        res = await api.post(`/site-grn/grn/${grnId}/approve`, { approval_remarks: remarks });
      } else if (type === 'reject') {
        res = await api.post(`/site-grn/grn/${grnId}/reject`, { reason, action_type: 'reject' });
      } else if (type === 'correction') {
        res = await api.post(`/site-grn/grn/${grnId}/reject`, { reason, action_type: 'correction' });
      } else if (type === 'reject_invoice') {
        res = await api.post(`/site-grn/invoices/${invoiceId || grnId}/reject`, { reason });
        fetchInvoices();
        if (selectedInvoice?.id === (invoiceId || grnId)) setSelectedInvoice(null);
      }

      showToast(res.data?.message || 'Action executed successfully!');
      setActionModal({ isOpen: false, grnId: null, invoiceId: null, type: '', reason: '', remarks: '' });
      if (selectedGrn?.id === grnId) viewGrnDetails(grnId);
      fetchGrnList();
      fetchMetrics();
    } catch (e) {
      showToast(e?.response?.data?.error || e.message, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const viewGrnDetails = async (id) => {
    setDetailsLoading(true);
    try {
      const res = await api.get(`/site-grn/grn/${id}`);
      if (res.data) setSelectedGrn(res.data);
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
    finally { setDetailsLoading(false); }
  };

  const handleOpenCreateInvoice = async (grnId) => {
    setSelectedApprovedGrnId(grnId);
    try {
      const res = await api.get(`/site-grn/invoices/grn-for-invoice/${grnId}`);
      if (res.data) {
        const data = res.data;
        const grn = data.grn;
        const autoPhotoUrl = grn?.challan_doc_url || (parsePhotos(grn?.material_photos)[0] || '');
        setInvoiceGrnData(data);
        setInvoiceForm({
          invoice_number: grn?.delivery_challan_no || '',
          invoice_date: grn?.challan_date || new Date().toISOString().slice(0, 10),
          due_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          attachment_url: autoPhotoUrl,
          remarks: grn?.remarks || '',
          items: (data.items || []).map(it => ({ ...it }))
        });
        setShowCreateInvoiceModal(true);
      }
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
  };

  const handleSaveInvoice = async () => {
    if (!invoiceForm.invoice_number?.trim()) {
      showToast('Invoice Number is required', 'error');
      return;
    }
    setSubmittingInvoice(true);
    try {
      const res = await api.post('/site-grn/invoices', {
        ...invoiceForm,
        grn_id: selectedApprovedGrnId,
        vendor_id: invoiceGrnData?.grn?.vendor_id || null,
        vendor_name: invoiceGrnData?.grn?.vendor_name || null
      });
      showToast(res.data?.message || 'Invoice created successfully!');
      setShowCreateInvoiceModal(false);
      fetchInvoices();
      fetchMetrics();
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
    finally { setSubmittingInvoice(false); }
  };

  const handleApproveInvoice = async (invoiceId) => {
    try {
      const res = await api.post(`/site-grn/invoices/${invoiceId}/approve`, { approval_remarks: 'Approved by Accounts' });
      showToast(res.data?.message || 'Invoice Approved!');
      fetchInvoices();
      fetchMetrics();
      if (selectedInvoice?.id === invoiceId) viewInvoiceDetails(invoiceId);
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
  };

  const handleResolveException = async () => {
    const { invoiceId, resolution_notes } = exceptionModal;
    if (!resolution_notes.trim()) {
      showToast('Resolution rationale is required', 'error');
      return;
    }
    try {
      const res = await api.post(`/site-grn/invoices/${invoiceId}/resolve-exception`, { resolution_notes });
      showToast(res.data?.message || 'Exception resolved');
      setExceptionModal({ isOpen: false, invoiceId: null, resolution_notes: '' });
      fetchInvoices();
      fetchMetrics();
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
  };

  const viewInvoiceDetails = async (id) => {
    try {
      const res = await api.get(`/site-grn/invoices/${id}`);
      if (res.data) setSelectedInvoice(res.data);
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
  };

  const handleOpenPayment = (inv) => {
    setPaymentModal({
      isOpen: true,
      invoice: inv,
      payment_date: new Date().toISOString().slice(0, 10),
      payment_mode: 'NEFT/RTGS',
      bank_reference: '',
      bank_name: 'HDFC Bank - Primary',
      tds_deduction: 0,
      other_deductions: 0,
      deduction_reason: '',
      payment_proof_url: '',
      payment_remarks: ''
    });
  };

  const handleProcessPayment = async () => {
    if (!paymentModal.bank_reference?.trim()) {
      showToast('Bank Reference / UTR Number is required', 'error');
      return;
    }
    setProcessingPayment(true);
    try {
      const res = await api.post('/site-grn/payments', {
        invoice_id: paymentModal.invoice.id,
        payment_date: paymentModal.payment_date,
        payment_mode: paymentModal.payment_mode,
        bank_reference: paymentModal.bank_reference,
        bank_name: paymentModal.bank_name,
        tds_deduction: paymentModal.tds_deduction,
        other_deductions: paymentModal.other_deductions,
        deduction_reason: paymentModal.deduction_reason,
        payment_proof_url: paymentModal.payment_proof_url,
        payment_remarks: paymentModal.payment_remarks
      });
      showToast(res.data?.message || 'Payment recorded successfully!');
      setPaymentModal({ isOpen: false, invoice: null });
      fetchPaymentsData();
      fetchMetrics();
    } catch (e) { showToast(e?.response?.data?.error || e.message, 'error'); }
    finally { setProcessingPayment(false); }
  };

  const handleKpiClick = (type) => {
    if (type === 'all_grn') {
      setGrnFilters({ site_id: '', vendor_id: '', po_number: '', status: 'all', search: '', from_date: '', to_date: '' });
      setActiveTab('grn_list');
    } else if (type === 'pending_verify') {
      setGrnFilters(prev => ({ ...prev, status: 'submitted' }));
      setActiveTab('grn_list');
    } else if (type === 'pending_invoices') {
      setInvoiceFilters({ status: 'pending', match_status: 'all', search: '', vendor_id: '' });
      setActiveTab('invoices');
    } else if (type === 'approved_pay') {
      setInvoiceFilters({ status: 'approved', match_status: 'all', search: '', vendor_id: '' });
      setActiveTab('invoices');
    } else if (type === 'paid') {
      setActiveTab('payments');
    }
  };

  // Status Badge Component
  const StatusBadge = ({ status }) => {
    const s = String(status || '').toLowerCase();
    let bg = 'bg-slate-100 text-slate-700 border-slate-300';
    let label = status;

    if (s === 'draft') {
      bg = 'bg-slate-100 text-slate-700 border-slate-300';
      label = 'Draft';
    } else if (s === 'submitted') {
      bg = 'bg-blue-50 text-blue-700 border-blue-200 font-medium';
      label = 'Submitted';
    } else if (s === 'under_verification' || s === 'verification') {
      bg = 'bg-amber-50 text-amber-700 border-amber-300 font-medium';
      label = 'Under Verification';
    } else if (s === 'approved') {
      bg = 'bg-emerald-50 text-emerald-700 border-emerald-300 font-semibold';
      label = 'Approved';
    } else if (s === 'rejected') {
      bg = 'bg-rose-50 text-rose-700 border-rose-300 font-medium';
      label = 'Rejected';
    } else if (s === 'correction') {
      bg = 'bg-orange-50 text-orange-700 border-orange-300 font-medium';
      label = 'Sent Back (Correction)';
    } else if (s === 'matched') {
      bg = 'bg-teal-50 text-teal-700 border-teal-300 font-semibold';
      label = '3-Way Matched';
    } else if (s === 'exception' || s === 'mismatched') {
      bg = 'bg-rose-50 text-rose-700 border-rose-300 font-semibold';
      label = '3-Way Discrepancy';
    } else if (s === 'paid') {
      bg = 'bg-emerald-100 text-emerald-800 border-emerald-400 font-bold';
      label = 'Paid (UTR Logged)';
    }

    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border ${bg}`}>
        {label}
      </span>
    );
  };

  return (
    <div className="p-2.5 sm:p-4 md:p-6 bg-slate-50 min-h-screen text-slate-800 font-sans">
      {/* Toast Alert */}
      {notification && (
        <div className={`fixed top-4 right-4 z-50 px-3.5 py-2.5 rounded-xl shadow-xl text-white font-medium flex items-center space-x-2 transition-all ${
          notification.type === 'error' ? 'bg-rose-600' : 'bg-emerald-600'
        }`}>
          {notification.type === 'error' ? <FiAlertTriangle className="w-4 h-4 flex-shrink-0" /> : <FiCheckCircle className="w-4 h-4 flex-shrink-0" />}
          <span className="text-xs sm:text-sm">{notification.msg}</span>
        </div>
      )}

      {/* Modern Compact & Responsive Header */}
      <div className="bg-white border border-slate-200/80 rounded-xl sm:rounded-2xl p-3 sm:p-5 mb-3 sm:mb-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="hidden sm:flex items-center space-x-1.5 text-[10px] sm:text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              <span>SOTYN ERP</span>
              <span>›</span>
              <span>Procurement</span>
              <span>›</span>
              <span className="text-indigo-600">Site Material Control</span>
            </div>
            <h1 className="text-base sm:text-xl md:text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2 sm:gap-2.5">
              <span className="p-1.5 sm:p-2 bg-indigo-50 text-indigo-600 rounded-lg sm:rounded-xl border border-indigo-100/80 shadow-xs">
                <FiTruck className="w-4 h-4 sm:w-5 sm:h-5" />
              </span>
              <span>Goods Receipt Note (GRN) & 3-Way Invoice</span>
            </h1>
            <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5 line-clamp-1 sm:line-clamp-none">
              Site Material Intake • Physical Quality Inspection • Auto-Stock Credit • 3-Way Match (PO + GRN + Invoice)
            </p>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {canCreateGRN && (
              <button
                onClick={() => {
                  setEditingGrnId(null);
                  setGrnForm({
                    vendor_po_id: '', po_number: '', vendor_id: '', vendor_name: '',
                    site_id: '', site_name: '', warehouse_id: '', warehouse_name: '',
                    delivery_challan_no: '', challan_date: new Date().toISOString().slice(0, 10),
                    vehicle_number: '', remarks: '', challan_doc_url: '', material_photos: [], items: []
                  });
                  setShowCreateModal(true);
                }}
                className="w-full sm:w-auto inline-flex items-center justify-center px-3.5 sm:px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm font-semibold rounded-lg sm:rounded-xl shadow-xs hover:shadow-indigo-200 transition-all gap-1.5 sm:gap-2"
              >
                <FiPlus className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.5]" />
                <span>Create Site GRN</span>
              </button>
            )}
          </div>
        </div>

        {/* Visual Workflow Stepper (Desktop only) */}
        <div className="mt-3.5 pt-3 border-t border-slate-100 hidden lg:flex items-center justify-between text-xs font-medium text-slate-500">
          <div className="flex items-center gap-1.5 text-indigo-700 font-semibold">
            <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[9px] font-bold">1</span>
            <span>Delivery & Create GRN</span>
          </div>
          <FiArrowRight className="text-slate-300 w-3 h-3" />
          <div className="flex items-center gap-1.5 text-indigo-700 font-semibold">
            <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[9px] font-bold">2</span>
            <span>Physical Verification</span>
          </div>
          <FiArrowRight className="text-slate-300 w-3 h-3" />
          <div className="flex items-center gap-1.5 text-emerald-700 font-semibold">
            <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[9px] font-bold">3</span>
            <span>GRN Approval (+Stock)</span>
          </div>
          <FiArrowRight className="text-slate-300 w-3 h-3" />
          <div className="flex items-center gap-1.5 text-blue-700 font-semibold">
            <span className="w-4 h-4 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[9px] font-bold">4</span>
            <span>Supplier 3-Way Match</span>
          </div>
          <FiArrowRight className="text-slate-300 w-3 h-3" />
          <div className="flex items-center gap-1.5 text-purple-700 font-semibold">
            <span className="w-4 h-4 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-[9px] font-bold">5</span>
            <span>Payment & UTR</span>
          </div>
        </div>
      </div>

      {/* KPI Cards (Clickable) */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-5 gap-2 sm:gap-3.5 mb-3 sm:mb-5">
        <div
          onClick={() => handleKpiClick('all_grn')}
          className={`bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border transition-all cursor-pointer shadow-xs hover:shadow-sm active:scale-[0.98] ${
            activeTab === 'grn_list' && grnFilters.status === 'all'
              ? 'border-indigo-500 ring-1 sm:ring-2 ring-indigo-500/20 bg-indigo-50/20'
              : 'border-slate-200/80 hover:border-indigo-300'
          }`}
          title="Click to view all GRNs"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] sm:text-[11px] font-bold text-slate-500 uppercase tracking-wider truncate pr-1">Total GRN</span>
            <span className="p-1 sm:p-1.5 bg-indigo-50 text-indigo-600 rounded-lg"><FiPackage className="w-3.5 h-3.5" /></span>
          </div>
          <div className="mt-1 text-lg sm:text-2xl font-bold sm:font-black text-slate-900">{metrics.totalGrn}</div>
          <div className="mt-0.5 text-[10px] sm:text-xs text-slate-500 font-medium truncate">
            {metrics.approvedGrn} Approved & In-Stock
          </div>
        </div>

        <div
          onClick={() => handleKpiClick('pending_verify')}
          className={`bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border transition-all cursor-pointer shadow-xs hover:shadow-sm active:scale-[0.98] ${
            activeTab === 'grn_list' && grnFilters.status === 'submitted'
              ? 'border-amber-500 ring-1 sm:ring-2 ring-amber-500/20 bg-amber-50/20'
              : 'border-slate-200/80 hover:border-amber-300'
          }`}
          title="Click to filter GRNs pending verification"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] sm:text-[11px] font-bold text-amber-600 uppercase tracking-wider truncate pr-1">Pending Verify</span>
            <span className="p-1 sm:p-1.5 bg-amber-50 text-amber-600 rounded-lg"><FiClock className="w-3.5 h-3.5" /></span>
          </div>
          <div className="mt-1 text-lg sm:text-2xl font-bold sm:font-black text-amber-700">{metrics.pendingGrnVerify}</div>
          <div className="mt-0.5 text-[10px] sm:text-xs text-slate-500 truncate">
            Site Inspection
          </div>
        </div>

        <div
          onClick={() => handleKpiClick('pending_invoices')}
          className={`bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border transition-all cursor-pointer shadow-xs hover:shadow-sm active:scale-[0.98] ${
            activeTab === 'invoices' && invoiceFilters.status === 'pending'
              ? 'border-blue-500 ring-1 sm:ring-2 ring-blue-500/20 bg-blue-50/20'
              : 'border-slate-200/80 hover:border-blue-300'
          }`}
          title="Click to view pending supplier invoices"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] sm:text-[11px] font-bold text-blue-600 uppercase tracking-wider truncate pr-1">Pending Inv</span>
            <span className="p-1 sm:p-1.5 bg-blue-50 text-blue-600 rounded-lg"><FiFileText className="w-3.5 h-3.5" /></span>
          </div>
          <div className="mt-1 text-lg sm:text-2xl font-bold sm:font-black text-blue-700">{metrics.pendingInvoiceApprove}</div>
          <div className="mt-0.5 text-[10px] sm:text-xs text-slate-500 truncate">
            {metrics.exceptionInvoices > 0 ? `${metrics.exceptionInvoices} Exceptions` : '3-Way Match'}
          </div>
        </div>

        <div
          onClick={() => handleKpiClick('approved_pay')}
          className={`bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border transition-all cursor-pointer shadow-xs hover:shadow-sm active:scale-[0.98] ${
            activeTab === 'invoices' && invoiceFilters.status === 'approved'
              ? 'border-purple-500 ring-1 sm:ring-2 ring-purple-500/20 bg-purple-50/20'
              : 'border-slate-200/80 hover:border-purple-300'
          }`}
          title="Click to view invoices approved for payment"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] sm:text-[11px] font-bold text-purple-600 uppercase tracking-wider truncate pr-1">Ready to Pay</span>
            <span className="p-1 sm:p-1.5 bg-purple-50 text-purple-600 rounded-lg"><FiShield className="w-3.5 h-3.5" /></span>
          </div>
          <div className="mt-1 text-lg sm:text-2xl font-bold sm:font-black text-purple-700">{metrics.approvedInvoicesPendingPay}</div>
          <div className="mt-0.5 text-[10px] sm:text-xs text-slate-500 truncate">
            Bank Disbursal
          </div>
        </div>

        <div
          onClick={() => handleKpiClick('paid')}
          className={`bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3.5 border transition-all cursor-pointer shadow-xs hover:shadow-sm active:scale-[0.98] col-span-2 lg:col-span-1 ${
            activeTab === 'payments'
              ? 'border-emerald-500 ring-1 sm:ring-2 ring-emerald-500/20 bg-emerald-50/20'
              : 'border-slate-200/80 hover:border-emerald-300'
          }`}
          title="Click to view payments and disbursement log"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] sm:text-[11px] font-bold text-emerald-600 uppercase tracking-wider truncate pr-1">Paid / Settled</span>
            <span className="p-1 sm:p-1.5 bg-emerald-50 text-emerald-600 rounded-lg"><FiDollarSign className="w-3.5 h-3.5" /></span>
          </div>
          <div className="mt-1 text-base sm:text-xl font-bold sm:font-black text-emerald-700 truncate">₹{(metrics.totalPaidAmount || 0).toLocaleString('en-IN')}</div>
          <div className="mt-0.5 text-[10px] sm:text-xs text-slate-500 truncate">
            {metrics.totalPaidCount} Vouchers Paid
          </div>
        </div>
      </div>

      {/* Navigation Tabs Bar */}
      <div className="border-b border-slate-200 mb-3 sm:mb-5 bg-white rounded-xl sm:rounded-2xl px-2 sm:px-4 pt-1 sm:pt-1.5 shadow-xs">
        <nav className="flex space-x-3 sm:space-x-6 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('grn_list')}
            className={`py-2 sm:py-3 px-1.5 border-b-2 font-semibold text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 whitespace-nowrap transition-colors ${
              activeTab === 'grn_list'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <FiTruck className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>1. Site GRN</span>
            <span className="ml-1 px-1.5 py-0.2 text-[10px] sm:text-xs rounded-full bg-slate-100 text-slate-700">{grnList.length}</span>
          </button>

          <button
            onClick={() => setActiveTab('invoices')}
            className={`py-2 sm:py-3 px-1.5 border-b-2 font-semibold text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 whitespace-nowrap transition-colors ${
              activeTab === 'invoices'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <FiFileText className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>2. Invoices & 3-Way</span>
            {metrics.exceptionInvoices > 0 && (
              <span className="px-1.5 py-0.2 text-[10px] sm:text-xs rounded-full bg-rose-100 text-rose-700 font-bold">{metrics.exceptionInvoices}</span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('payments')}
            className={`py-2 sm:py-3 px-1.5 border-b-2 font-semibold text-xs sm:text-sm flex items-center gap-1.5 sm:gap-2 whitespace-nowrap transition-colors ${
              activeTab === 'payments'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
          >
            <FiDollarSign className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>3. Payments & UTR</span>
            {pendingPaymentInvoices.length > 0 && (
              <span className="px-1.5 py-0.2 text-[10px] sm:text-xs rounded-full bg-purple-100 text-purple-700 font-bold">{pendingPaymentInvoices.length}</span>
            )}
          </button>
        </nav>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 1: GRN RECEIPTS */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'grn_list' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="bg-white p-2.5 sm:p-4 rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
            <div className="relative">
              <FiSearch className="absolute left-3 top-2.5 sm:top-3 text-slate-400 w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <input
                type="text"
                placeholder="Search GRN, Challan, Vendor..."
                value={grnFilters.search}
                onChange={(e) => setGrnFilters(prev => ({ ...prev, search: e.target.value }))}
                className="w-full pl-8 sm:pl-9 pr-3 py-1.5 sm:py-2 border border-slate-200 rounded-lg sm:rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50/50"
              />
            </div>

            <select
              value={grnFilters.site_id}
              onChange={(e) => setGrnFilters(prev => ({ ...prev, site_id: e.target.value }))}
              className="w-full px-2.5 sm:px-3 py-1.5 sm:py-2 border border-slate-200 rounded-lg sm:rounded-xl text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All Sites</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <select
              value={grnFilters.vendor_id}
              onChange={(e) => setGrnFilters(prev => ({ ...prev, vendor_id: e.target.value }))}
              className="w-full px-2.5 sm:px-3 py-1.5 sm:py-2 border border-slate-200 rounded-lg sm:rounded-xl text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All Vendors</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>

            <select
              value={grnFilters.status}
              onChange={(e) => setGrnFilters(prev => ({ ...prev, status: e.target.value }))}
              className="w-full px-2.5 sm:px-3 py-1.5 sm:py-2 border border-slate-200 rounded-lg sm:rounded-xl text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="all">All Statuses</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="under_verification">Under Verification</option>
              <option value="approved">Approved</option>
              <option value="correction">Sent Back (Correction)</option>
              <option value="rejected">Rejected</option>
            </select>

            <button
              onClick={fetchGrnList}
              className="px-3 sm:px-4 py-1.5 sm:py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg sm:rounded-xl text-xs sm:text-sm font-semibold flex items-center justify-center gap-1.5 sm:gap-2 transition"
            >
              <FiRefreshCw className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Filter Records
            </button>
          </div>

          {/* Table */}
          <div className="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm text-slate-700">
                <thead className="bg-slate-50 border-b border-slate-200 text-[10px] sm:text-xs uppercase font-semibold text-slate-500">
                  <tr>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">GRN No. & Date</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Delivery Challan</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Supplier / Vendor</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Site / Store</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-center">Quantities (Rec / Acc / Rej)</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">Value (₹)</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-center">Status</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grnLoading ? (
                    <tr><td colSpan="8" className="py-8 text-center text-slate-400">Loading GRN receipts...</td></tr>
                  ) : grnList.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="py-12 text-center text-slate-400">
                        <FiPackage className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                        <p className="text-base font-semibold text-slate-600">No Goods Receipt Notes found</p>
                        <p className="text-xs text-slate-400 mt-1">Create a new GRN when material arrives at site.</p>
                      </td>
                    </tr>
                  ) : (
                    grnList.map((g) => {
                      const mPhotos = parsePhotos(g.material_photos);
                      const challanUrl = g.challan_doc_url || '';
                      const primaryPhoto = challanUrl || mPhotos[0] || '';
                      const totalPhotosCount = (challanUrl ? 1 : 0) + mPhotos.length;

                      return (
                        <tr key={g.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3.5 px-4">
                            <button
                              onClick={() => viewGrnDetails(g.id)}
                              className="font-bold text-indigo-600 hover:text-indigo-800 hover:underline block"
                            >
                              {g.grn_number}
                            </button>
                            <span className="text-xs text-slate-400">{g.grn_date}</span>
                            {g.po_number && (
                              <span className="inline-block mt-0.5 text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-mono font-semibold">
                                PO: {g.po_number}
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-start gap-2.5">
                              {/* Photo Thumbnail / Preview Icon */}
                              {primaryPhoto ? (
                                <div className="relative group flex-shrink-0">
                                  {isPdfUrl(primaryPhoto) ? (
                                    <button
                                      type="button"
                                      onClick={() => setPreviewImage({ url: primaryPhoto, title: `Challan Doc (${g.delivery_challan_no})`, isPdf: true })}
                                      className="w-10 h-10 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex flex-col items-center justify-center shadow-2xs hover:bg-rose-100 hover:scale-105 transition cursor-pointer"
                                      title="Click to view PDF Challan"
                                    >
                                      <FiFileText className="w-4 h-4" />
                                      <span className="text-[8px] font-bold uppercase mt-0.5">PDF</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setPreviewImage({ url: primaryPhoto, title: `Challan Photo (${g.delivery_challan_no})`, isPdf: false })}
                                      className="w-10 h-10 rounded-lg overflow-hidden border border-indigo-200 shadow-2xs group-hover:border-indigo-500 group-hover:shadow-md hover:scale-105 transition bg-slate-100 relative block cursor-pointer"
                                      title="Click to zoom Challan Photo"
                                    >
                                      <img
                                        src={primaryPhoto}
                                        alt="Challan"
                                        className="w-full h-full object-cover"
                                        onError={(e) => { e.target.style.display = 'none'; }}
                                      />
                                      <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition text-white">
                                        <FiEye className="w-3.5 h-3.5" />
                                      </div>
                                    </button>
                                  )}
                                  {totalPhotosCount > 1 && (
                                    <span
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        viewGrnDetails(g.id);
                                      }}
                                      className="absolute -bottom-1 -right-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[9px] font-bold px-1 rounded-full border border-white shadow-xs cursor-pointer"
                                      title={`${totalPhotosCount} photos attached`}
                                    >
                                      +{totalPhotosCount - 1}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setQuickAttachModal({
                                    isOpen: true,
                                    grn: g,
                                    uploading: false,
                                    challan_doc_url: g.challan_doc_url || '',
                                    material_photos: parsePhotos(g.material_photos)
                                  })}
                                  className="w-9 h-9 rounded-lg border border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 flex flex-col items-center justify-center transition flex-shrink-0 cursor-pointer"
                                  title="Attach Photo"
                                >
                                  <FiCamera className="w-3.5 h-3.5" />
                                  <span className="text-[7px] font-bold mt-0.5 leading-none">+Photo</span>
                                </button>
                              )}

                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-slate-800">
                                  {g.delivery_challan_no}
                                </div>
                                <div className="text-xs text-slate-400 mt-0.5">
                                  {g.vehicle_number ? `Veh: ${g.vehicle_number}` : '—'}
                                </div>
                              </div>
                            </div>
                          </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-900">{g.vendor_name || '—'}</div>
                          <div className="text-xs text-slate-400">Rec by: {g.received_by_name || 'Store'}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-slate-800">{g.site_name || 'General Site'}</div>
                          <div className="text-xs text-indigo-600 font-medium">{g.warehouse_name || 'Site Store'}</div>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <div className="text-xs font-semibold space-x-1">
                            <span className="text-slate-700" title="Total Received">{g.total_received_qty}</span>
                            <span>/</span>
                            <span className="text-emerald-700 font-bold" title="Accepted">{g.total_accepted_qty}</span>
                            <span>/</span>
                            <span className={g.total_rejected_qty > 0 ? 'text-rose-600 font-bold' : 'text-slate-400'} title="Rejected">
                              {g.total_rejected_qty}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400">{g.item_count} items</div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-bold text-slate-900 font-mono">
                          ₹{Number(g.total_accepted_value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <StatusBadge status={g.status} />
                          {g.stock_updated === 1 && (
                            <div className="text-[10px] text-emerald-600 font-bold mt-0.5">✓ Stock In-Store</div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end space-x-1.5">
                            <button
                              onClick={() => viewGrnDetails(g.id)}
                              className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
                              title="View Details"
                            >
                              <FiEye className="w-4 h-4" />
                            </button>

                            <Link
                              to={`/site-grn/${g.id}/print`}
                              target="_blank"
                              className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg"
                              title="Print GRN Slip"
                            >
                              <FiPrinter className="w-4 h-4" />
                            </Link>

                            {canVerifyGRN && g.status === 'submitted' && (
                              <button
                                onClick={() => setActionModal({ isOpen: true, grnId: g.id, type: 'verify', reason: '', remarks: '' })}
                                className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg"
                              >
                                Verify
                              </button>
                            )}

                            {canApproveGRN && (g.status === 'under_verification' || g.status === 'submitted') && (
                              <>
                                <button
                                  onClick={() => setActionModal({ isOpen: true, grnId: g.id, type: 'approve', reason: '', remarks: '' })}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-xs"
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={() => setActionModal({ isOpen: true, grnId: g.id, type: 'reject', reason: '', remarks: '' })}
                                  className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg shadow-xs"
                                >
                                  Reject
                                </button>
                              </>
                            )}

                            {canManageInvoices && g.status === 'approved' && !g.linked_invoice_id && (
                              <button
                                onClick={() => handleOpenCreateInvoice(g.id)}
                                className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold rounded-lg flex items-center gap-1"
                              >
                                <FiLink className="w-3 h-3" /> + Invoice
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 2: INVOICES */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'invoices' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 flex-1 flex-wrap">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <FiSearch className="absolute left-3 top-3 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search Invoice No, Supplier, PO..."
                  value={invoiceFilters.search}
                  onChange={(e) => setInvoiceFilters(prev => ({ ...prev, search: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50/50"
                />
              </div>

              <select
                value={invoiceFilters.status}
                onChange={(e) => setInvoiceFilters(prev => ({ ...prev, status: e.target.value }))}
                className="px-3 py-2 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All Invoice Statuses</option>
                <option value="pending">⏳ Pending Approval ({metrics.pendingInvoiceApprove || 0})</option>
                <option value="approved">✓ Approved for Payment ({metrics.approvedInvoicesPendingPay || 0})</option>
                <option value="exception">⚠ Discrepancy / Hold ({metrics.exceptionInvoices || 0})</option>
                <option value="paid">💵 Paid / Settled</option>
              </select>

              <select
                value={invoiceFilters.match_status}
                onChange={(e) => setInvoiceFilters(prev => ({ ...prev, match_status: e.target.value }))}
                className="px-3 py-2 border border-slate-200 rounded-xl text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All 3-Way Statuses</option>
                <option value="matched">Matched (Clean)</option>
                <option value="mismatched">Discrepancies / Hold</option>
              </select>

              {(invoiceFilters.status !== 'all' || invoiceFilters.match_status !== 'all' || invoiceFilters.search) && (
                <button
                  onClick={() => setInvoiceFilters({ status: 'all', match_status: 'all', search: '', vendor_id: '' })}
                  className="px-2.5 py-2 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-xl font-semibold transition"
                >
                  Clear Filters
                </button>
              )}
            </div>

            <div className="text-xs text-slate-500 bg-amber-50 border border-amber-200 p-2.5 rounded-xl flex items-center gap-2">
              <FiInfo className="text-amber-600 flex-shrink-0" />
              <span>Invoices are cross-checked automatically against PO Rates & GRN Accepted Quantities.</span>
            </div>
          </div>

          <div className="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm text-slate-700">
                <thead className="bg-slate-50 border-b border-slate-200 text-[10px] sm:text-xs uppercase font-semibold text-slate-500">
                  <tr>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Invoice No. & Date</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Supplier / Vendor</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4">Linked GRN & PO</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">Taxable Amount</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">GST</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">Total (₹)</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-center">3-Way Match</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-center">Approval</th>
                    <th className="py-2.5 sm:py-3.5 px-3 sm:px-4 text-right">Actions</th>
                  </tr>
                </thead>
              <tbody className="divide-y divide-slate-100">
                {invoiceLoading ? (
                  <tr><td colSpan="9" className="py-8 text-center text-slate-400">Loading invoices...</td></tr>
                ) : invoiceList.length === 0 ? (
                  <tr>
                    <td colSpan="9" className="py-12 text-center text-slate-400">
                      <FiFileText className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                      <p className="text-base font-semibold text-slate-600">No Supplier Invoices found</p>
                      <p className="text-xs text-slate-400 mt-1">Create an invoice from an Approved GRN to trigger automated 3-way matching.</p>
                    </td>
                  </tr>
                ) : (
                  invoiceList.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3.5 px-4">
                        <button
                          onClick={() => viewInvoiceDetails(inv.id)}
                          className="font-bold text-slate-900 hover:text-indigo-600 block text-left"
                        >
                          {inv.invoice_number}
                        </button>
                        <span className="text-xs text-slate-400">{inv.invoice_date}</span>
                        {inv.attachment_url && (
                          <a
                            href={inv.attachment_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-0.5 ml-2 font-medium"
                          >
                            <FiPaperclip className="w-3 h-3" /> View Doc
                          </a>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900">{inv.vendor_name}</div>
                        <div className="text-xs text-slate-400">{inv.site_name}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="text-xs font-mono text-indigo-600 font-bold">{inv.grn_number}</div>
                        {inv.po_number && <div className="text-[11px] font-mono text-slate-500">PO: {inv.po_number}</div>}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono">
                        ₹{Number(inv.taxable_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-slate-500">
                        ₹{Number(inv.gst_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-3.5 px-4 text-right font-bold text-slate-900 font-mono">
                        ₹{Number(inv.total_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        {inv.match_status === 'matched' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">
                            <FiCheck className="w-3 h-3 mr-1" /> 3-Way Matched
                          </span>
                        ) : (
                          <div>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800">
                              <FiAlertTriangle className="w-3 h-3 mr-1" /> Discrepancy
                            </span>
                            {inv.resolution_notes && (
                              <div className="text-[10px] text-amber-700 font-semibold mt-0.5">Resolved by notes</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <StatusBadge status={inv.status} />
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => viewInvoiceDetails(inv.id)}
                            className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
                            title="View 3-Way Analysis"
                          >
                            <FiEye className="w-4 h-4" />
                          </button>

                          {inv.match_status === 'mismatched' && !inv.resolution_notes && (
                            <button
                              onClick={() => setExceptionModal({ isOpen: true, invoiceId: inv.id, resolution_notes: '' })}
                              className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg"
                            >
                              Resolve
                            </button>
                          )}

                          {canManageInvoices && (inv.status === 'matched' || (inv.status === 'exception' && inv.resolution_notes)) && (
                            <>
                              <button
                                onClick={() => handleApproveInvoice(inv.id)}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition shadow-xs"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => setActionModal({ isOpen: true, invoiceId: inv.id, type: 'reject_invoice', reason: '', remarks: '' })}
                                className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg transition shadow-xs"
                              >
                                Reject
                              </button>
                            </>
                          )}

                          {inv.status === 'approved' && !inv.linked_payment_id && (
                            <button
                              onClick={() => setActiveTab('payments')}
                              className="px-2.5 py-1 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-xs font-semibold rounded-lg flex items-center gap-1 transition"
                              title="Invoice Approved! Click to open Tab 3 for Payment & UTR"
                            >
                              <span>Ready to Pay →</span>
                            </button>
                          )}

                          {inv.status === 'paid' && (
                            <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold rounded flex items-center gap-0.5">
                              <FiCheck className="w-3 h-3" /> Paid
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* TAB 3: PAYMENTS */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeTab === 'payments' && (
        <div className="space-y-4 sm:space-y-6">
          <div className="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs p-3.5 sm:p-5">
            <h3 className="text-sm sm:text-base font-bold text-slate-900 mb-2.5 flex items-center gap-2">
              <span className="p-1 sm:p-1.5 bg-purple-50 text-purple-600 rounded-lg"><FiClock className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></span>
              <span>Approved Invoices Pending Payment ({pendingPaymentInvoices.length})</span>
            </h3>

            {pendingPaymentInvoices.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-xs sm:text-sm">
                ✓ No approved invoices currently pending payment.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm text-slate-700">
                  <thead className="bg-slate-50 border-b border-slate-200 text-[10px] sm:text-xs uppercase font-semibold text-slate-500">
                    <tr>
                      <th className="py-2.5 px-3">Invoice No.</th>
                      <th className="py-2.5 px-3">Supplier</th>
                      <th className="py-2.5 px-3">GRN Reference</th>
                      <th className="py-2.5 px-3">Approved By</th>
                      <th className="py-2.5 px-3 text-right">Approved Amount</th>
                      <th className="py-2.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pendingPaymentInvoices.map(inv => (
                      <tr key={inv.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-bold text-slate-900">{inv.invoice_number}</td>
                        <td className="py-2.5 px-3 font-medium">{inv.vendor_name}</td>
                        <td className="py-2.5 px-3 font-mono text-xs font-semibold text-indigo-600">{inv.grn_number}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-500">{inv.approved_by_name || 'Accounts'} ({inv.approved_at?.slice(0, 10)})</td>
                        <td className="py-2.5 px-3 text-right font-bold text-slate-900 font-mono">
                          ₹{Number(inv.total_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {canProcessPayment ? (
                            <button
                              onClick={() => handleOpenPayment(inv)}
                              className="px-3 sm:px-3.5 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg sm:rounded-xl shadow-xs"
                            >
                              Process Payment & UTR
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400 italic">Finance Role Required</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Paid Vouchers Register */}
          <div className="bg-white rounded-xl sm:rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-slate-200">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 flex items-center gap-2">
                <span className="p-1 sm:p-1.5 bg-emerald-50 text-emerald-600 rounded-lg"><FiCheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4" /></span>
                <span>Paid Vouchers & Bank UTR Register</span>
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-700">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase font-semibold text-slate-500">
                  <tr>
                    <th className="py-3 px-4">Voucher No. & Date</th>
                    <th className="py-3 px-4">Supplier / Vendor</th>
                    <th className="py-3 px-4">Invoice & GRN</th>
                    <th className="py-3 px-4">Payment Mode & Bank</th>
                    <th className="py-3 px-4 font-mono">Bank Reference / UTR</th>
                    <th className="py-3 px-4 text-right">Approved Amount</th>
                    <th className="py-3 px-4 text-right">Deductions</th>
                    <th className="py-3 px-4 text-right">Net Paid (₹)</th>
                    <th className="py-3 px-4 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paymentLoading ? (
                    <tr><td colSpan="9" className="py-8 text-center text-slate-400">Loading payment vouchers...</td></tr>
                  ) : paymentList.length === 0 ? (
                    <tr><td colSpan="9" className="py-8 text-center text-slate-400">No payment vouchers recorded yet.</td></tr>
                  ) : (
                    paymentList.map(pay => (
                      <tr key={pay.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-bold text-slate-900">
                          <div>{pay.payment_voucher_no}</div>
                          <div className="text-xs text-slate-400 font-normal">{pay.payment_date}</div>
                        </td>
                        <td className="py-3 px-4 font-medium">{pay.vendor_name}</td>
                        <td className="py-3 px-4 text-xs font-mono">
                          <div>Inv: {pay.invoice_number}</div>
                          <div className="text-indigo-600 font-semibold">{pay.grn_number}</div>
                        </td>
                        <td className="py-3 px-4 text-xs">
                          <span className="font-bold text-slate-800">{pay.payment_mode}</span>
                          <div className="text-slate-400">{pay.bank_name || 'HDFC Bank'}</div>
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-slate-900">
                          {pay.bank_reference}
                          {pay.payment_proof_url && (
                            <a
                              href={pay.payment_proof_url}
                              target="_blank"
                              rel="noreferrer"
                              className="block text-[10px] text-indigo-600 hover:underline font-normal"
                            >
                              View UTR Receipt
                            </a>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono">
                          ₹{Number(pay.approved_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-rose-600">
                          -₹{(Number(pay.tds_deduction || 0) + Number(pay.other_deductions || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-emerald-700">
                          ₹{Number(pay.net_payable || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <StatusBadge status={pay.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: CREATE / EDIT GRN */}
      {/* ───────────────────────────────────────────────────────────── */}
      {showCreateModal && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg border border-indigo-100 shadow-sm"><FiTruck className="w-4 h-4" /></span>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Create Goods Receipt Note (GRN)</h2>
                  <p className="text-[11px] text-slate-500">Record site material delivery, verified counts, and inspection notes.</p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs bg-white">
              {/* ⚡ AI Smart Challan Auto-Reader Banner */}
              <div className="bg-gradient-to-r from-indigo-50 via-purple-50 to-blue-50 border-2 border-dashed border-indigo-300 hover:border-indigo-500 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 transition shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-sm shadow-md flex-shrink-0">
                    <FiZap className="w-5 h-5 text-amber-300 animate-pulse" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <span>⚡ Smart AI Challan Auto-Fill</span>
                      <span className="bg-indigo-600 text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider">AI OCR</span>
                    </div>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Challan PDF / Photo upload karein — Vendor, Site, DC No, Vehicle & Items <b>automatic fill</b> ho jayenge.
                    </p>
                  </div>
                </div>

                <label className={`cursor-pointer px-4 py-2 rounded-xl text-xs font-bold text-white shadow flex items-center gap-2 transition whitespace-nowrap ${
                  parsingChallan ? 'bg-indigo-400 cursor-not-allowed animate-pulse' : 'bg-indigo-600 hover:bg-indigo-700 active:scale-95 shadow-indigo-200'
                }`}>
                  {parsingChallan ? (
                    <>
                      <FiLoader className="w-4 h-4 animate-spin" />
                      <span>Reading Challan...</span>
                    </>
                  ) : (
                    <>
                      <FiUploadCloud className="w-4 h-4" />
                      <span>Upload Challan & Auto-Fill</span>
                    </>
                  )}
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp"
                    disabled={parsingChallan}
                    onChange={(e) => handleFileUpload(e, 'challan')}
                    className="hidden"
                  />
                </label>
              </div>

              <div className="bg-slate-50/90 p-3 rounded-lg border border-slate-200">
                <h3 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-600"></span>
                  1. Purchase Order & Delivery Context
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Purchase Order (PO)</label>
                    <select
                      value={grnForm.vendor_po_id}
                      onChange={(e) => handlePoSelect(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="">-- No PO / Direct Inward --</option>
                      {availablePos.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.po_number} — {p.vendor_name || 'Vendor'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Supplier / Vendor</label>
                    {grnForm.vendor_po_id ? (
                      <input
                        type="text"
                        readOnly
                        value={grnForm.vendor_name || 'Vendor from PO'}
                        className="w-full px-2.5 py-1.5 border border-slate-200 bg-slate-100 rounded-lg text-xs text-slate-700 font-medium"
                      />
                    ) : (
                      <select
                        value={grnForm.vendor_id}
                        onChange={(e) => {
                          const vid = e.target.value;
                          const vObj = vendors.find(v => v.id === +vid);
                          setGrnForm(prev => ({ ...prev, vendor_id: vid, vendor_name: vObj?.name || prev.vendor_name }));
                        }}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-indigo-500 focus:outline-none font-medium"
                      >
                        <option value="">{grnForm.vendor_name ? `Auto: ${grnForm.vendor_name}` : '-- Select Vendor --'}</option>
                        {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    )}
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Site / Project</label>
                    <select
                      value={grnForm.site_id}
                      onChange={(e) => {
                        const sid = e.target.value;
                        const sObj = sites.find(s => s.id === +sid);
                        const matchedWh = warehouses.find(w => w.site_id === +sid && w.type === 'site_store');
                        setGrnForm(prev => ({
                          ...prev,
                          site_id: sid,
                          site_name: sObj?.name || '',
                          warehouse_id: matchedWh?.id || prev.warehouse_id,
                          warehouse_name: matchedWh?.name || prev.warehouse_name
                        }));
                      }}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="">{grnForm.site_name ? `Auto: ${grnForm.site_name}` : '-- Select Site --'}</option>
                      {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Destination Site Store</label>
                    <select
                      value={grnForm.warehouse_id}
                      onChange={(e) => {
                        const wid = e.target.value;
                        const wObj = warehouses.find(w => w.id === +wid);
                        setGrnForm(prev => ({ ...prev, warehouse_id: wid, warehouse_name: wObj?.name || '' }));
                      }}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="">-- Select Store --</option>
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({w.type === 'site_store' ? 'Site Store' : 'Central'})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Challan Info */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Delivery Challan Number <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. DC-2026-9810"
                    value={grnForm.delivery_challan_no}
                    onChange={(e) => setGrnForm(prev => ({ ...prev, delivery_challan_no: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Challan Date</label>
                  <input
                    type="date"
                    value={grnForm.challan_date}
                    onChange={(e) => setGrnForm(prev => ({ ...prev, challan_date: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Vehicle Number</label>
                  <input
                    type="text"
                    placeholder="e.g. PB-10-CZ-8821"
                    value={grnForm.vehicle_number}
                    onChange={(e) => setGrnForm(prev => ({ ...prev, vehicle_number: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Materials Table */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-600"></span>
                    2. Materials Received & Physical Inspection
                  </h3>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={handleAddManualItem}
                      className="px-2 py-0.5 text-[11px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded border border-indigo-200 flex items-center gap-1 transition"
                    >
                      <FiPlus className="w-3 h-3" /> + Add Item
                    </button>
                    <button
                      type="button"
                      onClick={handleAcceptAllItems}
                      className="px-2 py-0.5 text-[11px] bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold rounded border border-emerald-200 flex items-center gap-1 transition"
                      title="Approve / Accept all items"
                    >
                      <FiCheck className="w-3 h-3" /> Approve All
                    </button>
                    <button
                      type="button"
                      onClick={handleRejectAllItems}
                      className="px-2 py-0.5 text-[11px] bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded border border-rose-200 flex items-center gap-1 transition"
                      title="Reject all items"
                    >
                      <FiX className="w-3 h-3" /> Reject All
                    </button>
                    <div className="text-[10px] text-indigo-700 font-semibold bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                      Accepted + Rejected = Received
                    </div>
                  </div>
                </div>

                {poLoading ? (
                  <div className="p-4 text-center text-slate-400 bg-slate-50 rounded-lg border border-slate-200 text-xs">Loading PO items...</div>
                ) : grnForm.items.length === 0 ? (
                  <div className="p-5 text-center text-slate-500 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-xs flex flex-col items-center justify-center gap-2">
                    <p>Select a Purchase Order above to auto-fill items, or click below to add materials directly without a PO.</p>
                    <button
                      type="button"
                      onClick={handleAddManualItem}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 shadow-sm transition"
                    >
                      <FiPlus className="w-3.5 h-3.5" /> + Add Line Item (Direct Inward)
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-56 overflow-y-auto">
                    <table className="w-full text-left text-xs text-slate-700">
                      <thead className="bg-slate-100 text-slate-600 uppercase font-semibold text-[10px] sticky top-0">
                        <tr>
                          <th className="py-2 px-2.5">Material Description</th>
                          <th className="py-2 px-1.5 text-center w-12">Unit</th>
                          <th className="py-2 px-1.5 text-right w-12">PO Qty</th>
                          <th className="py-2 px-1.5 text-right w-12">Prev</th>
                          <th className="py-2 px-1.5 w-16">Rec Qty</th>
                          <th className="py-2 px-1.5 text-center w-32">Item Decision</th>
                          <th className="py-2 px-1.5 w-16">Accepted</th>
                          <th className="py-2 px-1.5 w-16">Rejected</th>
                          <th className="py-2 px-1.5 w-18 text-right">Rate (₹)</th>
                          <th className="py-2 px-1.5 w-20 text-right">Total (₹)</th>
                          <th className="py-2 px-2">Rejection Reason</th>
                          <th className="py-2 px-1 text-center w-7"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 bg-white">
                        {grnForm.items.map((item, idx) => {
                          const curr = Number(item.curr_received_qty || 0);
                          const acc = Number(item.accepted_qty || 0);
                          const rej = Number(item.rejected_qty || 0);
                          const rate = Number(item.unit_rate || 0);
                          const lineTot = acc * rate;
                          const hasError = Math.abs((acc + rej) - curr) > 0.001;
                          const isAllAccepted = acc > 0 && rej === 0 && acc === curr;
                          const isAllRejected = rej > 0 && acc === 0 && rej === curr;

                          return (
                            <tr key={idx} className={hasError ? 'bg-rose-50/70' : 'hover:bg-slate-50'}>
                              <td className="py-1.5 px-2.5">
                                {item.is_manual || !item.item_master_id ? (
                                  <input
                                    type="text"
                                    placeholder="Enter material / item name..."
                                    value={item.material_name}
                                    onChange={(e) => updateGrnItemQty(idx, 'material_name', e.target.value)}
                                    className="w-full px-2 py-1 border border-slate-300 rounded text-xs font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                  />
                                ) : (
                                  <div>
                                    <div className="font-bold text-slate-900">{item.material_name}</div>
                                    {item.item_code && <div className="text-[9px] text-slate-400 font-mono">{item.item_code}</div>}
                                  </div>
                                )}
                              </td>
                              <td className="py-1.5 px-1.5 text-center text-slate-500">
                                {item.is_manual ? (
                                  <input
                                    type="text"
                                    value={item.unit}
                                    onChange={(e) => updateGrnItemQty(idx, 'unit', e.target.value)}
                                    className="w-12 px-1 py-1 border border-slate-300 rounded text-xs text-center font-medium"
                                  />
                                ) : item.unit}
                              </td>
                              <td className="py-1.5 px-1.5 text-right font-mono text-slate-600">{item.po_qty}</td>
                              <td className="py-1.5 px-1.5 text-right font-mono text-slate-500">{item.prev_received_qty}</td>
                              <td className="py-1.5 px-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  value={item.curr_received_qty}
                                  onChange={(e) => updateGrnItemQty(idx, 'curr_received_qty', e.target.value)}
                                  className="w-full px-1.5 py-1 border border-slate-300 rounded text-xs font-bold text-slate-900 text-right"
                                />
                              </td>
                              <td className="py-1.5 px-1.5 text-center">
                                <div className="inline-flex items-center rounded-lg p-0.5 bg-slate-100 border border-slate-200 gap-0.5">
                                  <button
                                    type="button"
                                    onClick={() => handleAcceptItem(idx)}
                                    className={`px-1.5 py-0.5 text-[10px] font-bold rounded transition flex items-center gap-0.5 ${
                                      isAllAccepted
                                        ? 'bg-emerald-600 text-white shadow-xs'
                                        : 'text-slate-600 hover:text-emerald-700 hover:bg-white'
                                    }`}
                                    title="Approve / Accept entire quantity"
                                  >
                                    <FiCheck className="w-2.5 h-2.5" /> Approve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRejectItem(idx)}
                                    className={`px-1.5 py-0.5 text-[10px] font-bold rounded transition flex items-center gap-0.5 ${
                                      isAllRejected
                                        ? 'bg-rose-600 text-white shadow-xs'
                                        : 'text-slate-600 hover:text-rose-700 hover:bg-white'
                                    }`}
                                    title="Reject entire quantity"
                                  >
                                    <FiX className="w-2.5 h-2.5" /> Reject
                                  </button>
                                </div>
                              </td>
                              <td className="py-1.5 px-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  value={item.accepted_qty}
                                  onChange={(e) => updateGrnItemQty(idx, 'accepted_qty', e.target.value)}
                                  className="w-full px-1.5 py-1 border border-emerald-300 rounded text-xs font-bold text-emerald-700 text-right bg-emerald-50/30"
                                />
                              </td>
                              <td className="py-1.5 px-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  value={item.rejected_qty}
                                  onChange={(e) => updateGrnItemQty(idx, 'rejected_qty', e.target.value)}
                                  className="w-full px-1.5 py-1 border border-rose-300 rounded text-xs font-bold text-rose-700 text-right bg-rose-50/30"
                                />
                              </td>
                              <td className="py-1.5 px-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  placeholder="0.00"
                                  value={item.unit_rate}
                                  onChange={(e) => updateGrnItemQty(idx, 'unit_rate', e.target.value)}
                                  className="w-full px-1.5 py-1 border border-slate-300 rounded text-xs font-semibold text-slate-900 text-right focus:ring-1 focus:ring-indigo-500"
                                />
                              </td>
                              <td className="py-1.5 px-1.5 text-right font-bold text-slate-900 font-mono">
                                ₹{lineTot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                              </td>
                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  placeholder={rej > 0 ? 'Mandatory reason...' : 'Notes'}
                                  value={item.rejection_reason || ''}
                                  onChange={(e) => updateGrnItemQty(idx, 'rejection_reason', e.target.value)}
                                  className={`w-full px-1.5 py-1 border rounded text-[11px] ${
                                    rej > 0 && !item.rejection_reason ? 'border-rose-500 bg-rose-50' : 'border-slate-200'
                                  }`}
                                />
                              </td>
                              <td className="py-1.5 px-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveGrnItem(idx)}
                                  className="text-slate-400 hover:text-rose-600 p-1 rounded"
                                  title="Remove item"
                                >
                                  <FiTrash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-slate-50 border-t border-slate-200 text-xs font-semibold text-slate-700">
                        <tr>
                          <td colSpan="6" className="py-2 px-2.5 text-right font-bold text-slate-600">Total:</td>
                          <td className="py-2 px-1.5 text-right font-bold text-emerald-700">
                            {grnForm.items.reduce((s, it) => s + Number(it.accepted_qty || 0), 0)}
                          </td>
                          <td className="py-2 px-1.5 text-right font-bold text-rose-700">
                            {grnForm.items.reduce((s, it) => s + Number(it.rejected_qty || 0), 0)}
                          </td>
                          <td></td>
                          <td className="py-2 px-1.5 text-right font-bold font-mono text-indigo-700">
                            ₹{grnForm.items.reduce((s, it) => s + (Number(it.accepted_qty || 0) * Number(it.unit_rate || 0)), 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </td>
                          <td colSpan="2"></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {/* Upload Attachments & Live Photo Previews */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Delivery Challan Document Box */}
                <div className="border border-slate-200 p-3 rounded-xl bg-slate-50 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                        <FiUploadCloud className="text-indigo-600 w-3.5 h-3.5" />
                        <span>Delivery Challan (Auto-Fill & Photo)</span>
                      </label>
                      {grnForm.challan_doc_url && (
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                          ✓ Photo Loaded
                        </span>
                      )}
                    </div>

                    {parsingChallan ? (
                      <div className="flex items-center justify-center gap-2 py-4 text-xs text-indigo-600 font-bold bg-indigo-50/50 rounded-lg border border-indigo-100 animate-pulse">
                        <FiLoader className="w-4 h-4 animate-spin" />
                        <span>Scanning & Auto-Reading Challan...</span>
                      </div>
                    ) : grnForm.challan_doc_url ? (
                      <div className="flex items-center gap-3 bg-white p-2 rounded-lg border border-slate-200 shadow-2xs">
                        {isPdfUrl(grnForm.challan_doc_url) ? (
                          <div
                            onClick={() => setPreviewImage({ url: grnForm.challan_doc_url, title: 'Attached Challan (PDF)', isPdf: true })}
                            className="w-12 h-12 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex flex-col items-center justify-center cursor-pointer hover:bg-rose-100 transition flex-shrink-0"
                          >
                            <FiFileText className="w-5 h-5" />
                            <span className="text-[8px] font-bold uppercase mt-0.5">PDF</span>
                          </div>
                        ) : (
                          <div
                            onClick={() => setPreviewImage({ url: grnForm.challan_doc_url, title: 'Attached Challan Photo', isPdf: false })}
                            className="w-12 h-12 rounded-lg overflow-hidden border border-indigo-200 relative group cursor-pointer flex-shrink-0 bg-slate-100"
                          >
                            <img src={grnForm.challan_doc_url} alt="Challan" className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition">
                              <FiEye className="w-3.5 h-3.5" />
                            </div>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-semibold text-slate-800 truncate">
                            {grnForm.delivery_challan_no ? `DC: ${grnForm.delivery_challan_no}` : 'Challan Document'}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            <button
                              type="button"
                              onClick={() => setPreviewImage({
                                url: grnForm.challan_doc_url,
                                title: `Challan (${grnForm.delivery_challan_no || 'Document'})`,
                                isPdf: isPdfUrl(grnForm.challan_doc_url)
                              })}
                              className="text-indigo-600 hover:text-indigo-800 text-[11px] font-bold flex items-center gap-0.5 hover:underline cursor-pointer"
                            >
                              <FiEye className="w-3 h-3" /> View Full
                            </button>
                            <span className="text-slate-300">·</span>
                            <button
                              type="button"
                              onClick={() => setGrnForm(prev => ({ ...prev, challan_doc_url: '' }))}
                              className="text-rose-600 hover:text-rose-800 text-[11px] font-semibold flex items-center gap-0.5 hover:underline cursor-pointer"
                            >
                              <FiTrash2 className="w-3 h-3" /> Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp"
                        onChange={(e) => handleFileUpload(e, 'challan')}
                        className="text-[11px] text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-[11px] file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-700 cursor-pointer w-full"
                      />
                    )}
                  </div>
                </div>

                {/* Unloading Photos Box */}
                <div className="border border-slate-200 p-3 rounded-xl bg-slate-50 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                        <FiCamera className="text-indigo-600 w-3.5 h-3.5" />
                        <span>Unloading / Site Photos</span>
                      </label>
                      {grnForm.material_photos?.length > 0 && (
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                          ✓ {grnForm.material_photos.length} Photo(s)
                        </span>
                      )}
                    </div>

                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileUpload(e, 'photo')}
                      className="text-[11px] text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-[11px] file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-700 cursor-pointer w-full"
                    />

                    {grnForm.material_photos?.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-2 overflow-x-auto py-1">
                        {grnForm.material_photos.map((pUrl, pIdx) => (
                          <div key={pIdx} className="relative group w-10 h-10 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0 bg-slate-100">
                            <img
                              src={pUrl}
                              alt="Unload"
                              onClick={() => setPreviewImage({ url: pUrl, title: `Unloading Photo #${pIdx + 1}`, isPdf: false })}
                              className="w-full h-full object-cover cursor-pointer"
                            />
                            <button
                              type="button"
                              onClick={() => setGrnForm(prev => ({
                                ...prev,
                                material_photos: prev.material_photos.filter((_, idx) => idx !== pIdx)
                              }))}
                              className="absolute top-0.5 right-0.5 bg-rose-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition shadow-xs cursor-pointer"
                              title="Delete Photo"
                            >
                              <FiX className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">Receipt Remarks / Gate Notes</label>
                <textarea
                  rows="1"
                  placeholder="Material received in good condition..."
                  value={grnForm.remarks}
                  onChange={(e) => setGrnForm(prev => ({ ...prev, remarks: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between bg-slate-50">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-semibold transition"
              >
                Cancel
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={submittingGrn}
                  onClick={() => handleSaveGrn(false)}
                  className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg text-xs font-semibold transition"
                >
                  Save as Draft
                </button>
                <button
                  type="button"
                  disabled={submittingGrn}
                  onClick={() => handleSaveGrn(true)}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-sm flex items-center gap-1.5 transition"
                >
                  <FiCheck className="w-3.5 h-3.5" /> Submit GRN
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: GRN DETAILS DRAWER */}
      {/* ───────────────────────────────────────────────────────────── */}
      {selectedGrn && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2.5">
                <span className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg border border-indigo-100 shadow-sm"><FiPackage className="w-4 h-4" /></span>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">{selectedGrn.grn_number}</h2>
                  <span className="text-[11px] text-slate-500">Dated {selectedGrn.grn_date} · Challan: {selectedGrn.delivery_challan_no}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={selectedGrn.status} />
                <button
                  onClick={() => setSelectedGrn(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg ml-2 transition"
                >
                  <FiX className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs bg-white">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs">
                <div>
                  <span className="text-slate-400 block font-medium text-[10px]">Supplier</span>
                  <span className="font-bold text-slate-900">{selectedGrn.vendor_name || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block font-medium text-[10px]">Site / Store</span>
                  <span className="font-bold text-slate-900">{selectedGrn.site_name} / {selectedGrn.warehouse_name}</span>
                </div>
                <div>
                  <span className="text-slate-400 block font-medium text-[10px]">PO Reference</span>
                  <span className="font-bold text-indigo-600">{selectedGrn.po_number || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block font-medium text-[10px]">Vehicle No.</span>
                  <span className="font-bold text-slate-900">{selectedGrn.vehicle_number || '—'}</span>
                </div>
              </div>

              {/* Attached Delivery Challan & Material Photos Section */}
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <FiCamera className="text-indigo-600 w-3.5 h-3.5" />
                    <span>Attached Delivery Challan & Photos</span>
                  </h4>
                  <button
                    type="button"
                    onClick={() => setQuickAttachModal({
                      isOpen: true,
                      grn: selectedGrn,
                      uploading: false,
                      challan_doc_url: selectedGrn.challan_doc_url || '',
                      material_photos: parsePhotos(selectedGrn.material_photos)
                    })}
                    className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded border border-indigo-200 flex items-center gap-1 transition cursor-pointer"
                  >
                    <FiCamera className="w-3 h-3" /> Update / Add Photos
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Challan Doc Preview */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-200 flex items-center gap-3">
                    {selectedGrn.challan_doc_url ? (
                      <>
                        {isPdfUrl(selectedGrn.challan_doc_url) ? (
                          <div
                            onClick={() => setPreviewImage({ url: selectedGrn.challan_doc_url, title: `Challan Doc (${selectedGrn.delivery_challan_no})`, isPdf: true })}
                            className="w-14 h-14 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex flex-col items-center justify-center cursor-pointer hover:bg-rose-100 transition flex-shrink-0"
                          >
                            <FiFileText className="w-6 h-6" />
                            <span className="text-[8px] font-bold uppercase mt-0.5">PDF</span>
                          </div>
                        ) : (
                          <div
                            onClick={() => setPreviewImage({ url: selectedGrn.challan_doc_url, title: `Challan Photo (${selectedGrn.delivery_challan_no})`, isPdf: false })}
                            className="w-14 h-14 rounded-lg overflow-hidden border border-indigo-200 relative group cursor-pointer flex-shrink-0 bg-slate-100"
                          >
                            <img src={selectedGrn.challan_doc_url} alt="Challan" className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition">
                              <FiEye className="w-4 h-4" />
                            </div>
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] text-slate-400 block uppercase font-bold">Delivery Challan Proof</span>
                          <span className="font-bold text-slate-800 text-xs truncate block">{selectedGrn.delivery_challan_no}</span>
                          <button
                            type="button"
                            onClick={() => setPreviewImage({
                              url: selectedGrn.challan_doc_url,
                              title: `Challan (${selectedGrn.delivery_challan_no})`,
                              isPdf: isPdfUrl(selectedGrn.challan_doc_url)
                            })}
                            className="text-indigo-600 hover:text-indigo-800 text-[11px] font-bold mt-1 flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <FiEye className="w-3 h-3" /> View Large Photo
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-2 text-slate-400 text-xs py-2 w-full justify-center">
                        <FiInfo className="w-4 h-4" />
                        <span>No Delivery Challan photo attached</span>
                      </div>
                    )}
                  </div>

                  {/* Unloading Photos Gallery */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-400 block uppercase font-bold mb-1.5">Unloading Material Photos</span>
                    {parsePhotos(selectedGrn.material_photos).length > 0 ? (
                      <div className="flex items-center gap-2 overflow-x-auto py-0.5">
                        {parsePhotos(selectedGrn.material_photos).map((pUrl, pIdx) => (
                          <div
                            key={pIdx}
                            onClick={() => setPreviewImage({ url: pUrl, title: `Unloading Photo #${pIdx + 1} (${selectedGrn.grn_number})`, isPdf: false })}
                            className="w-12 h-12 rounded-lg overflow-hidden border border-slate-200 relative group cursor-pointer flex-shrink-0 bg-slate-100 hover:border-indigo-500 hover:scale-105 transition"
                          >
                            <img src={pUrl} alt="Unloading" className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition">
                              <FiEye className="w-3 h-3" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-slate-400 text-xs py-2 justify-center">
                        <span>No unloading photos uploaded</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider mb-1.5">Verified Material Table</h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 text-slate-600 font-semibold uppercase text-[10px] sticky top-0">
                      <tr>
                        <th className="py-1.5 px-2.5">Item</th>
                        <th className="py-1.5 px-1.5 text-center">Unit</th>
                        <th className="py-1.5 px-1.5 text-right">PO Qty</th>
                        <th className="py-1.5 px-1.5 text-right">Received</th>
                        <th className="py-1.5 px-1.5 text-right text-emerald-700">Accepted</th>
                        <th className="py-1.5 px-1.5 text-right text-rose-700">Rejected</th>
                        <th className="py-1.5 px-1.5 text-center">Decision</th>
                        <th className="py-1.5 px-2">Remarks / Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {(selectedGrn.items || []).map((it, idx) => {
                        const acc = Number(it.accepted_qty || 0);
                        const rej = Number(it.rejected_qty || 0);
                        return (
                          <tr key={idx}>
                            <td className="py-1.5 px-2.5 font-semibold text-slate-900">{it.material_name}</td>
                            <td className="py-1.5 px-1.5 text-center text-slate-500">{it.unit}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono">{it.po_qty}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono">{it.curr_received_qty}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono font-bold text-emerald-700">{acc}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono font-bold text-rose-700">{rej}</td>
                            <td className="py-1.5 px-1.5 text-center">
                              {acc > 0 && rej === 0 ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                  ✓ Approved
                                </span>
                              ) : rej > 0 && acc === 0 ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">
                                  ✕ Rejected
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                                  ⚠️ Partial
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 px-2 text-slate-500 text-[11px]">{it.rejection_reason || it.remarks || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Audit Log */}
              <div>
                <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider mb-1.5">GRN Audit Trail & Governance</h4>
                <div className="space-y-1.5 bg-slate-50 p-3 rounded-lg border border-slate-200 max-h-32 overflow-y-auto">
                  {(selectedGrn.audit_logs || []).map((log, idx) => (
                    <div key={idx} className="flex items-start space-x-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="font-semibold text-slate-900 text-[11px]">
                          {log.action} — <span className="font-normal text-slate-600">{log.performed_by_name}</span>
                        </div>
                        <div className="text-slate-500 text-[10px]">{log.remarks}</div>
                      </div>
                      <div className="text-[9px] text-slate-400">{log.timestamp}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between bg-slate-50">
              <Link
                to={`/site-grn/${selectedGrn.id}/print`}
                target="_blank"
                className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm"
              >
                <FiPrinter className="w-3.5 h-3.5" /> Print GRN Slip
              </Link>

              <div className="flex items-center space-x-2">
                {canVerifyGRN && selectedGrn.status === 'submitted' && (
                  <button
                    onClick={() => setActionModal({ isOpen: true, grnId: selectedGrn.id, type: 'verify', reason: '', remarks: '' })}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold shadow-sm"
                  >
                    Mark Verified
                  </button>
                )}
                {canApproveGRN && (selectedGrn.status === 'under_verification' || selectedGrn.status === 'submitted') && (
                  <>
                    <button
                      onClick={() => setActionModal({ isOpen: true, grnId: selectedGrn.id, type: 'correction', reason: '', remarks: '' })}
                      className="px-3 py-1.5 bg-orange-100 hover:bg-orange-200 text-orange-800 rounded-lg text-xs font-semibold"
                    >
                      Send Back
                    </button>
                    <button
                      onClick={() => setActionModal({ isOpen: true, grnId: selectedGrn.id, type: 'reject', reason: '', remarks: '' })}
                      className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs"
                    >
                      Reject GRN
                    </button>
                    <button
                      onClick={() => setActionModal({ isOpen: true, grnId: selectedGrn.id, type: 'approve', reason: '', remarks: '' })}
                      className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm"
                    >
                      Approve GRN (+Stock)
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: ACTION (APPROVE / VERIFY / REJECT) */}
      {/* ───────────────────────────────────────────────────────────── */}
      {actionModal.isOpen && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-4 border border-slate-200">
            <h3 className="text-sm font-bold text-slate-900 mb-2">
              {actionModal.type === 'verify' && 'Verify Goods Receipt Note'}
              {actionModal.type === 'approve' && 'Approve GRN & Update Site Stock'}
              {actionModal.type === 'reject' && 'Reject Goods Receipt Note'}
              {actionModal.type === 'correction' && 'Send Back for Correction'}
              {actionModal.type === 'reject_invoice' && 'Reject Supplier Invoice'}
            </h3>

            {actionModal.type === 'approve' && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 mb-3 font-medium">
                ✓ Approving this GRN will <strong>automatically add the Accepted Quantity</strong> to Site Store inventory.
              </div>
            )}

            {(actionModal.type === 'reject' || actionModal.type === 'correction' || actionModal.type === 'reject_invoice') && (
              <div className="mb-2.5">
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows="2"
                  required
                  placeholder="Explain rejection / correction reason..."
                  value={actionModal.reason}
                  onChange={(e) => setActionModal(prev => ({ ...prev, reason: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-rose-500 focus:outline-none"
                />
              </div>
            )}

            <div className="mb-3">
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Remarks / Notes</label>
              <textarea
                rows="2"
                placeholder="Optional remarks..."
                value={actionModal.remarks}
                onChange={(e) => setActionModal(prev => ({ ...prev, remarks: e.target.value }))}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setActionModal({ isOpen: false, grnId: null, type: '', reason: '', remarks: '' })}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleGrnAction}
                className={`px-3.5 py-1.5 text-white rounded-lg text-xs font-bold ${
                  actionModal.type === 'reject' ? 'bg-rose-600 hover:bg-rose-700' :
                  actionModal.type === 'correction' ? 'bg-orange-600 hover:bg-orange-700' :
                  actionModal.type === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' :
                  'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: CREATE INVOICE */}
      {/* ───────────────────────────────────────────────────────────── */}
      {showCreateInvoiceModal && invoiceGrnData && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <FiFileText className="text-indigo-600 w-4 h-4" />
                  <span>Create Supplier Invoice (Linked to GRN {invoiceGrnData.grn.grn_number})</span>
                </h2>
                <p className="text-[11px] text-slate-500">
                  PO: {invoiceGrnData.grn.po_number || '—'} · Supplier: {invoiceGrnData.grn.vendor_name}
                </p>
              </div>
              <button
                onClick={() => setShowCreateInvoiceModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs bg-white">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Invoice Number <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. INV-98124"
                    value={invoiceForm.invoice_number}
                    onChange={(e) => setInvoiceForm(prev => ({ ...prev, invoice_number: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-bold focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Invoice Date</label>
                  <input
                    type="date"
                    value={invoiceForm.invoice_date}
                    onChange={(e) => setInvoiceForm(prev => ({ ...prev, invoice_date: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Payment Due Date</label>
                  <input
                    type="date"
                    value={invoiceForm.due_date}
                    onChange={(e) => setInvoiceForm(prev => ({ ...prev, due_date: e.target.value }))}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* 3-Way Match Input Grid */}
              <div>
                <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-wider mb-1.5">
                  Material Line Items (PO vs GRN Accepted vs Invoice)
                </h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 text-slate-600 font-semibold uppercase text-[10px] sticky top-0">
                      <tr>
                        <th className="py-2 px-2.5">Material</th>
                        <th className="py-2 px-1.5 text-right">PO Rate</th>
                        <th className="py-2 px-1.5 text-right text-emerald-700">GRN Accepted</th>
                        <th className="py-2 px-1.5 w-20">Inv Qty</th>
                        <th className="py-2 px-1.5 w-20">Inv Rate (₹)</th>
                        <th className="py-2 px-1.5 text-center">GST %</th>
                        <th className="py-2 px-2.5 text-right">Total (₹)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {invoiceForm.items.map((it, idx) => {
                        const invQty = Number(it.invoice_qty || 0);
                        const invRate = Number(it.invoice_rate || 0);
                        const grnAcc = Number(it.grn_accepted_qty || 0);
                        const poRate = Number(it.po_rate || 0);
                        const tax = Number(it.tax_rate || 18);
                        const lineTot = (invQty * invRate) * (1 + tax / 100);
                        const hasMismatch = Math.abs(invQty - grnAcc) > 0.001 || Math.abs(invRate - poRate) > 0.01;

                        return (
                          <tr key={idx} className={hasMismatch ? 'bg-amber-50' : ''}>
                            <td className="py-1.5 px-2.5 font-semibold text-slate-900">{it.material_name}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono text-slate-500">₹{poRate}</td>
                            <td className="py-1.5 px-1.5 text-right font-mono font-bold text-emerald-700">{grnAcc} {it.unit}</td>
                            <td className="py-1.5 px-1.5">
                              <input
                                type="number"
                                step="any"
                                value={it.invoice_qty}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  setInvoiceForm(prev => {
                                    const next = [...prev.items];
                                    next[idx].invoice_qty = val;
                                    return { ...prev, items: next };
                                  });
                                }}
                                className="w-full px-1.5 py-1 border border-slate-300 rounded text-right font-bold text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                              />
                            </td>
                            <td className="py-1.5 px-1.5">
                              <input
                                type="number"
                                step="any"
                                value={it.invoice_rate}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  setInvoiceForm(prev => {
                                    const next = [...prev.items];
                                    next[idx].invoice_rate = val;
                                    return { ...prev, items: next };
                                  });
                                }}
                                className="w-full px-1.5 py-1 border border-slate-300 rounded text-right font-bold text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                              />
                            </td>
                            <td className="py-1.5 px-1.5 text-center font-mono text-xs">{tax}%</td>
                            <td className="py-1.5 px-2.5 text-right font-mono font-bold text-slate-900 text-xs">
                              ₹{lineTot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Upload Invoice Attachment & Auto-Filled Photo Preview */}
              <div className="border border-slate-200 p-3 rounded-xl bg-slate-50">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                    <FiUploadCloud className="text-indigo-600 w-3.5 h-3.5" />
                    <span>Vendor Invoice Document / Photo</span>
                  </label>
                  {invoiceForm.attachment_url && (
                    <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                      ✓ Photo Auto-Filled from GRN
                    </span>
                  )}
                </div>

                {invoiceForm.attachment_url ? (
                  <div className="flex items-center gap-3 bg-white p-2.5 rounded-lg border border-slate-200 shadow-2xs">
                    {isPdfUrl(invoiceForm.attachment_url) ? (
                      <div
                        onClick={() => setPreviewImage({ url: invoiceForm.attachment_url, title: `Invoice Doc (${invoiceForm.invoice_number || 'Vendor'})`, isPdf: true })}
                        className="w-12 h-12 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex flex-col items-center justify-center cursor-pointer hover:bg-rose-100 transition flex-shrink-0"
                      >
                        <FiFileText className="w-5 h-5" />
                        <span className="text-[8px] font-bold uppercase mt-0.5">PDF</span>
                      </div>
                    ) : (
                      <div
                        onClick={() => setPreviewImage({ url: invoiceForm.attachment_url, title: `Invoice Photo (${invoiceForm.invoice_number || 'Vendor'})`, isPdf: false })}
                        className="w-12 h-12 rounded-lg overflow-hidden border border-indigo-200 relative group cursor-pointer flex-shrink-0 bg-slate-100"
                        title="Click to zoom invoice photo"
                      >
                        <img src={invoiceForm.attachment_url} alt="Invoice" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition">
                          <FiEye className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-semibold text-slate-800 truncate">
                        {invoiceForm.invoice_number ? `Invoice Copy: ${invoiceForm.invoice_number}` : 'Attached Invoice Document'}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <button
                          type="button"
                          onClick={() => setPreviewImage({
                            url: invoiceForm.attachment_url,
                            title: `Invoice (${invoiceForm.invoice_number || 'Document'})`,
                            isPdf: isPdfUrl(invoiceForm.attachment_url)
                          })}
                          className="text-indigo-600 hover:text-indigo-800 text-[11px] font-bold flex items-center gap-0.5 hover:underline cursor-pointer"
                        >
                          <FiEye className="w-3 h-3" /> View Photo
                        </button>
                        <span className="text-slate-300">·</span>
                        <button
                          type="button"
                          onClick={() => setInvoiceForm(prev => ({ ...prev, attachment_url: '' }))}
                          className="text-rose-600 hover:text-rose-800 text-[11px] font-semibold flex items-center gap-0.5 hover:underline cursor-pointer"
                        >
                          <FiTrash2 className="w-3 h-3" /> Remove / Change
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => handleFileUpload(e, 'invoice_doc')}
                    className="text-[11px] text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-[11px] file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-700 cursor-pointer w-full"
                  />
                )}
              </div>
            </div>

            <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between bg-slate-50">
              <button
                type="button"
                onClick={() => setShowCreateInvoiceModal(false)}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submittingInvoice}
                onClick={handleSaveInvoice}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-sm flex items-center gap-1.5 transition"
              >
                <FiCheck className="w-3.5 h-3.5" /> 3-Way Match & Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: 3-WAY INVOICE DETAIL & EXCEPTION RESOLUTION */}
      {/* ───────────────────────────────────────────────────────────── */}
      {selectedInvoice && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Invoice {selectedInvoice.invoice_number} (3-Way Verification)</h3>
                <span className="text-[11px] text-slate-500">Supplier: {selectedInvoice.vendor_name} · GRN: {selectedInvoice.grn_number}</span>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={selectedInvoice.status} />
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg ml-2 transition"
                >
                  <FiX className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs bg-white">
              {selectedInvoice.match_status === 'mismatched' && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-rose-900 text-xs">
                    <FiAlertTriangle className="w-3.5 h-3.5" /> 3-Way Mismatch / Variance Detected
                  </div>
                  <p className="text-[11px]">{selectedInvoice.exception_reason || 'Discrepancy in quantities or rates between PO, GRN, and Invoice.'}</p>
                  {selectedInvoice.resolution_notes && (
                    <div className="mt-2 p-2 bg-white rounded border border-rose-200 text-slate-800 text-[11px]">
                      <strong>Resolution:</strong> {selectedInvoice.resolution_notes}
                    </div>
                  )}
                </div>
              )}

              <div className="border border-slate-200 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-600 font-semibold uppercase text-[10px] sticky top-0">
                    <tr>
                      <th className="py-1.5 px-2.5">Item</th>
                      <th className="py-1.5 px-1.5 text-right">PO Rate</th>
                      <th className="py-1.5 px-1.5 text-right">GRN Acc</th>
                      <th className="py-1.5 px-1.5 text-right">Inv Qty</th>
                      <th className="py-1.5 px-1.5 text-right">Inv Rate</th>
                      <th className="py-1.5 px-1.5 text-center">Status</th>
                      <th className="py-1.5 px-2.5 text-right">Line Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {(selectedInvoice.items || []).map((it, idx) => (
                      <tr key={idx} className={(!it.qty_matched || !it.rate_matched) ? 'bg-rose-50/60' : ''}>
                        <td className="py-1.5 px-2.5 font-semibold text-slate-900">{it.material_name}</td>
                        <td className="py-1.5 px-1.5 text-right font-mono">₹{it.po_rate}</td>
                        <td className="py-1.5 px-1.5 text-right font-mono font-bold text-emerald-700">{it.grn_accepted_qty}</td>
                        <td className="py-1.5 px-1.5 text-right font-mono font-bold">{it.invoice_qty}</td>
                        <td className="py-1.5 px-1.5 text-right font-mono">₹{it.invoice_rate}</td>
                        <td className="py-1.5 px-1.5 text-center text-[10px]">
                          {it.qty_matched && it.rate_matched ? (
                            <span className="text-emerald-700 font-bold">✓ Match</span>
                          ) : (
                            <span className="text-rose-700 font-bold">⚠️ Variance</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2.5 text-right font-mono font-bold text-slate-900">
                          ₹{Number(it.line_total || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedInvoice.attachment_url && (
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-[10px] text-slate-400 block uppercase font-bold mb-1.5">Attached Invoice Document / Photo</span>
                  <div className="flex items-center gap-3 bg-white p-2.5 rounded-lg border border-slate-200">
                    {isPdfUrl(selectedInvoice.attachment_url) ? (
                      <div
                        onClick={() => setPreviewImage({ url: selectedInvoice.attachment_url, title: `Invoice Doc (${selectedInvoice.invoice_number})`, isPdf: true })}
                        className="w-12 h-12 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 flex flex-col items-center justify-center cursor-pointer hover:bg-rose-100 transition flex-shrink-0"
                      >
                        <FiFileText className="w-5 h-5" />
                        <span className="text-[8px] font-bold uppercase mt-0.5">PDF</span>
                      </div>
                    ) : (
                      <div
                        onClick={() => setPreviewImage({ url: selectedInvoice.attachment_url, title: `Invoice Photo (${selectedInvoice.invoice_number})`, isPdf: false })}
                        className="w-12 h-12 rounded-lg overflow-hidden border border-indigo-200 relative group cursor-pointer flex-shrink-0 bg-slate-100"
                      >
                        <img src={selectedInvoice.attachment_url} alt="Invoice Doc" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition">
                          <FiEye className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-slate-800 text-xs block">{selectedInvoice.invoice_number}</span>
                      <button
                        type="button"
                        onClick={() => setPreviewImage({
                          url: selectedInvoice.attachment_url,
                          title: `Invoice Doc (${selectedInvoice.invoice_number})`,
                          isPdf: isPdfUrl(selectedInvoice.attachment_url)
                        })}
                        className="text-indigo-600 hover:text-indigo-800 text-[11px] font-bold mt-0.5 flex items-center gap-1 hover:underline cursor-pointer"
                      >
                        <FiEye className="w-3 h-3" /> View Large Photo / Document
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between bg-slate-50">
              <button
                type="button"
                onClick={() => setSelectedInvoice(null)}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-200 rounded-lg text-xs font-semibold transition"
              >
                Close
              </button>

              <div className="flex items-center space-x-2">
                {selectedInvoice.match_status === 'mismatched' && !selectedInvoice.resolution_notes && (
                  <button
                    onClick={() => setExceptionModal({ isOpen: true, invoiceId: selectedInvoice.id, resolution_notes: '' })}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold shadow-sm"
                  >
                    Resolve Discrepancy
                  </button>
                )}

                {canManageInvoices && (selectedInvoice.status === 'matched' || selectedInvoice.resolution_notes) && selectedInvoice.status !== 'approved' && selectedInvoice.status !== 'rejected' && (
                  <>
                    <button
                      onClick={() => setActionModal({ isOpen: true, invoiceId: selectedInvoice.id, type: 'reject_invoice', reason: '', remarks: '' })}
                      className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold shadow-xs"
                    >
                      Reject Invoice
                    </button>
                    <button
                      onClick={() => handleApproveInvoice(selectedInvoice.id)}
                      className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-sm"
                    >
                      Approve Invoice for Payment
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: EXCEPTION RESOLUTION */}
      {/* ───────────────────────────────────────────────────────────── */}
      {exceptionModal.isOpen && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-4 border border-slate-200">
            <h3 className="text-sm font-bold text-slate-900 mb-1">Resolve 3-Way Match Exception</h3>
            <p className="text-[11px] text-slate-500 mb-2.5">
              Provide authorization rationale for price/quantity variance.
            </p>

            <textarea
              rows="3"
              required
              placeholder="e.g. Authorized by PM: Freight included in line rate per revision agreement..."
              value={exceptionModal.resolution_notes}
              onChange={(e) => setExceptionModal(prev => ({ ...prev, resolution_notes: e.target.value }))}
              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-amber-500 focus:outline-none mb-3"
            />

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setExceptionModal({ isOpen: false, invoiceId: null, resolution_notes: '' })}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleResolveException}
                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-sm"
              >
                Save Resolution
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: PROCESS PAYMENT */}
      {/* ───────────────────────────────────────────────────────────── */}
      {paymentModal.isOpen && paymentModal.invoice && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-4 border border-slate-200">
            <h3 className="text-sm font-bold text-slate-900 mb-1 flex items-center gap-2">
              <span className="p-1 bg-purple-100 text-purple-700 rounded"><FiDollarSign className="w-4 h-4" /></span>
              <span>Disburse Payment & Record UTR</span>
            </h3>
            <p className="text-[11px] text-slate-500 mb-3">
              Invoice #{paymentModal.invoice.invoice_number} · Supplier: {paymentModal.invoice.vendor_name}
            </p>

            <div className="space-y-2.5 text-xs">
              <div className="p-2.5 bg-purple-50/70 rounded-lg border border-purple-100 flex items-center justify-between">
                <div>
                  <span className="text-slate-500 block text-[10px] font-medium">Approved Invoice Total</span>
                  <span className="text-sm font-extrabold text-slate-900 font-mono">
                    ₹{Number(paymentModal.invoice.total_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-slate-500 block text-[10px] font-medium">Net Payable</span>
                  <span className="text-sm font-extrabold text-purple-700 font-mono">
                    ₹{Math.max(0, Number(paymentModal.invoice.total_amount || 0) - Number(paymentModal.tds_deduction || 0) - Number(paymentModal.other_deductions || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">TDS Deduction (₹)</label>
                  <input
                    type="number"
                    step="any"
                    value={paymentModal.tds_deduction}
                    onChange={(e) => setPaymentModal(prev => ({ ...prev, tds_deduction: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-purple-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Other Deductions (₹)</label>
                  <input
                    type="number"
                    step="any"
                    value={paymentModal.other_deductions}
                    onChange={(e) => setPaymentModal(prev => ({ ...prev, other_deductions: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-purple-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Payment Mode</label>
                  <select
                    value={paymentModal.payment_mode}
                    onChange={(e) => setPaymentModal(prev => ({ ...prev, payment_mode: e.target.value }))}
                    className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs bg-white focus:ring-1 focus:ring-purple-500 focus:outline-none"
                  >
                    <option value="NEFT/RTGS">NEFT / RTGS</option>
                    <option value="IMPS">IMPS</option>
                    <option value="UPI">UPI</option>
                    <option value="Cheque">Cheque</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Payment Date</label>
                  <input
                    type="date"
                    value={paymentModal.payment_date}
                    onChange={(e) => setPaymentModal(prev => ({ ...prev, payment_date: e.target.value }))}
                    className="w-full px-2 py-1 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-purple-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-800 mb-1">
                  Bank Reference / UTR Number <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. HDFC2026092800192831"
                  value={paymentModal.bank_reference}
                  onChange={(e) => setPaymentModal(prev => ({ ...prev, bank_reference: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-900 focus:ring-1 focus:ring-purple-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">Attach Bank Payment Proof</label>
                <input
                  type="file"
                  onChange={(e) => handleFileUpload(e, 'payment_proof')}
                  className="text-[11px] text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[11px] file:font-semibold file:bg-purple-600 file:text-white cursor-pointer"
                />
                {paymentModal.payment_proof_url && <span className="text-[11px] text-emerald-600 ml-2 font-bold">✓ Attached</span>}
              </div>
            </div>

            <div className="mt-4 pt-2.5 border-t border-slate-200 flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => setPaymentModal({ isOpen: false, invoice: null })}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={processingPayment}
                onClick={handleProcessPayment}
                className="px-3.5 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold shadow-sm"
              >
                {processingPayment ? 'Processing...' : 'Confirm & Mark Paid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: IMAGE & DOCUMENT LIGHTBOX / PREVIEW */}
      {/* ───────────────────────────────────────────────────────────── */}
      {previewImage && (
        <div className="!m-0 fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-xs">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden border border-slate-700">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="p-1.5 bg-indigo-600 rounded-lg"><FiImage className="w-4 h-4 text-white" /></span>
                <h3 className="text-sm font-bold truncate">{previewImage.title || 'Document Preview'}</h3>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewImage.url}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition"
                  title="Open full size in new tab"
                >
                  <FiExternalLink className="w-3.5 h-3.5" /> Open Tab
                </a>
                <a
                  href={previewImage.url}
                  download
                  className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-sm transition"
                  title="Download File"
                >
                  <FiDownload className="w-3.5 h-3.5" /> Download
                </a>
                <button
                  onClick={() => setPreviewImage(null)}
                  className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg ml-1 transition cursor-pointer"
                >
                  <FiX className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-3 sm:p-4 overflow-auto flex-1 bg-slate-950/90 flex items-center justify-center min-h-[300px]">
              {previewImage.isPdf || isPdfUrl(previewImage.url) ? (
                <iframe
                  src={previewImage.url}
                  title="PDF Preview"
                  className="w-full h-[75vh] rounded-lg bg-white border border-slate-800 shadow"
                />
              ) : (
                <img
                  src={previewImage.url}
                  alt={previewImage.title || 'Preview'}
                  className="max-h-[78vh] max-w-full object-contain rounded-lg shadow-2xl transition duration-200"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* MODAL: QUICK ATTACH PHOTOS TO EXISTING GRN */}
      {/* ───────────────────────────────────────────────────────────── */}
      {quickAttachModal.isOpen && quickAttachModal.grn && (
        <div className="!m-0 fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-slate-200">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg border border-indigo-100">
                  <FiCamera className="w-4 h-4" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Attach Photos to {quickAttachModal.grn.grn_number}</h3>
                  <span className="text-[11px] text-slate-500">Challan: {quickAttachModal.grn.delivery_challan_no}</span>
                </div>
              </div>
              <button
                onClick={() => setQuickAttachModal({ isOpen: false, grn: null, uploading: false, challan_doc_url: '', material_photos: [] })}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition"
              >
                <FiX className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Delivery Challan Photo */}
              <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
                <label className="block text-xs font-bold text-slate-800 mb-1.5 flex items-center gap-1.5">
                  <FiUploadCloud className="text-indigo-600 w-3.5 h-3.5" />
                  <span>Delivery Challan Document / Photo</span>
                </label>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp"
                  onChange={(e) => handleQuickFileUpload(e, 'challan')}
                  className="text-xs text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white cursor-pointer w-full"
                />
                {quickAttachModal.challan_doc_url && (
                  <div className="mt-2 flex items-center gap-2 bg-white p-2 rounded-lg border border-slate-200">
                    <span className="text-xs text-emerald-600 font-bold flex items-center gap-1">
                      <FiCheck className="w-3.5 h-3.5" /> Challan Attached
                    </span>
                    <button
                      type="button"
                      onClick={() => setPreviewImage({ url: quickAttachModal.challan_doc_url, title: 'Challan Photo', isPdf: isPdfUrl(quickAttachModal.challan_doc_url) })}
                      className="text-indigo-600 hover:underline text-xs font-semibold ml-auto cursor-pointer"
                    >
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickAttachModal(prev => ({ ...prev, challan_doc_url: '' }))}
                      className="text-rose-600 hover:underline text-xs font-semibold cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>

              {/* Unloading Photos */}
              <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
                <label className="block text-xs font-bold text-slate-800 mb-1.5 flex items-center gap-1.5">
                  <FiCamera className="text-indigo-600 w-3.5 h-3.5" />
                  <span>Unloading Material Photos</span>
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleQuickFileUpload(e, 'photo')}
                  className="text-xs text-slate-500 file:mr-2 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white cursor-pointer w-full"
                />
                {quickAttachModal.material_photos?.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 overflow-x-auto py-1">
                    {quickAttachModal.material_photos.map((pUrl, pIdx) => (
                      <div key={pIdx} className="relative group w-12 h-12 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0 bg-slate-100">
                        <img src={pUrl} alt="Photo" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setQuickAttachModal(prev => ({
                            ...prev,
                            material_photos: prev.material_photos.filter((_, idx) => idx !== pIdx)
                          }))}
                          className="absolute top-0.5 right-0.5 bg-rose-600 text-white rounded-full p-0.5 shadow-xs cursor-pointer"
                        >
                          <FiX className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setQuickAttachModal({ isOpen: false, grn: null, uploading: false, challan_doc_url: '', material_photos: [] })}
                className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={quickAttachModal.uploading}
                onClick={handleSaveQuickPhotos}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-sm flex items-center gap-1.5"
              >
                <FiCheck className="w-3.5 h-3.5" /> {quickAttachModal.uploading ? 'Saving...' : 'Save Photos'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
