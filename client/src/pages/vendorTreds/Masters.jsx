import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { RecordList } from '../../components/vendorTreds/Records';

export default function Masters(props) {
  const { canView } = useAuth();
  const active = props.kind || 'catalog';
  return <div className="space-y-4">
    <div className="card p-4"><h3 className="font-semibold text-slate-800">Existing ERP Masters</h3><p className="text-xs text-slate-500 mt-1">Company, vendor, product and employee identities use the existing ERP records.</p><div className="flex flex-wrap gap-2 mt-3">
      {canView('customers') && <Link className="btn btn-secondary" to="/customers">Companies / Clients</Link>}
      {canView('vendors') && <Link className="btn btn-secondary" to="/vendors">Vendor Companies</Link>}
      {canView('item_master') && <Link className="btn btn-secondary" to="/item-master">Products / Services</Link>}
      {canView('employees') && <Link className="btn btn-secondary" to="/employees">Employees</Link>}
    </div></div>
    <div className="flex flex-wrap gap-2">{[['catalog', 'Platforms, Documents & Sectors'], ['contacts', 'Procurement / AP Contacts']].map(([kind, title]) => <button type="button" key={kind} onClick={() => props.onKind(kind)} className={`btn ${active === kind ? 'btn-primary' : 'btn-secondary'}`}>{title}</button>)}</div>
    <RecordList {...props} kind={active} />
  </div>;
}
