#!/usr/bin/env python3
import os
os.chdir('/home/chenye/pv-ops-platform/frontend')

COMMON_ROLE_CODE = '''
    /* ============ Role-Based Access Control ============ */
    var ROLES = { admin: 4, manager: 3, operator: 2, viewer: 1 };
    function getUserRole() {
      var userStr = localStorage.getItem("currentUser");
      if (!userStr) { window.location.href = "login.html"; return "viewer"; }
      try { return JSON.parse(userStr).role || "viewer"; } catch(e) { return "viewer"; }
    }
    function hasPermission(minRole) { return (ROLES[getUserRole()] || 0) >= (ROLES[minRole] || 1); }
    function hideElement(id) { var el = document.getElementById(id); if (el) el.style.display = "none"; }
    function showElement(id) { var el = document.getElementById(id); if (el) el.style.display = ""; }
'''

def add_role_code(content, extra_code=""):
    role_block = COMMON_ROLE_CODE + extra_code
    for pattern in ['</script>\n</body>', '</script>\n\n</body>', '</script></body>']:
        if pattern in content:
            return content.replace(pattern, role_block + '\n  </script>\n</body>')
    idx = content.rfind('</script>')
    if idx >= 0:
        return content[:idx] + role_block + '\n  ' + content[idx:]
    return content

# ====== audit.html ======
with open('audit.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html">\U0001f6e1\ufe0f \u5ba1\u8ba1\u65e5\u5fd7</a>', '<a class="nav-tab" id="nav-audit" href="audit.html">\U0001f6e1\ufe0f \u5ba1\u8ba1\u65e5\u5fd7</a>')
# Use bytes for emoji matching since Python string might not match
content = content.replace('<a class="nav-tab active" href="audit.html">', '<a class="nav-tab active" id="nav-audit" href="audit.html">')
content = content.replace('<a class="nav-tab" href="users.html">', '<a class="nav-tab" id="nav-users" href="users.html">')
content = add_role_code(content, '''
    // Admin-only page: redirect non-admin users
    if (!hasPermission("admin")) {
      window.location.href = "index.html";
    }
''')
with open('audit.html', 'w') as f:
    f.write(content)
print("audit.html done")

# ====== alert-rules.html ======
with open('alert-rules.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html">', '<a class="nav-tab" id="nav-users" href="users.html">')
content = content.replace('<a class="nav-tab" href="audit.html">', '<a class="nav-tab" id="nav-audit" href="audit.html">')
content = content.replace('onclick="seedAlertRules()">', 'id="btn-seed-rules" onclick="seedAlertRules()">')
content = content.replace('onclick="showCreateRule()">', 'id="btn-add-rule" onclick="showCreateRule()">')
old_actions = '''<td class="actions-cell">
              <button class="btn btn-sm ${rule.enabled ? 'btn-orange' : 'btn-green'}" onclick="toggleRule(${rule.id}, ${!rule.enabled})">${rule.enabled ? '禁用' : '启用'}</button>
              <button class="btn btn-sm btn-red" onclick="deleteRule(${rule.id})">删除</button>
            </td>'''
new_actions = '<td class="actions-cell">${hasPermission("manager") ? `<button class="btn btn-sm ${rule.enabled ? \'btn-orange\' : \'btn-green\'}" onclick="toggleRule(${rule.id}, ${!rule.enabled})">${rule.enabled ? \'禁用\' : \'启用\'}</button><button class="btn btn-sm btn-red" onclick="deleteRule(${rule.id})">删除</button>` : \'<span style="color:var(--text-muted);font-size:0.75rem;">--</span>\'}</td>'
content = content.replace(old_actions, new_actions)
content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
      if (!hasPermission("manager")) hideElement("btn-add-rule");
      if (!hasPermission("admin")) hideElement("btn-seed-rules");
    }
    applyRoleControls();
''')
with open('alert-rules.html', 'w') as f:
    f.write(content)
print("alert-rules.html done")

# ====== workorder.html ======
with open('workorder.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html"', '<a class="nav-tab" id="nav-users" href="users.html"')
content = content.replace('<a class="nav-tab" href="audit.html"', '<a class="nav-tab" id="nav-audit" href="audit.html"')
content = content.replace('<button class="btn create-btn" onclick="openCreateModal()">', '<button class="btn create-btn" id="btn-create-wo" onclick="openCreateModal()">')

# Modify detail modal: hide buttons for viewer
content = content.replace(
    '<button class="btn btn-sm btn-danger" onclick="deleteWorkOrder(${wo.id})">',
    '${hasPermission("operator") ? \'<button class="btn btn-sm btn-danger" onclick="deleteWorkOrder(${wo.id})"> : \'</span>\'}<button class="btn btn-sm btn-danger" style="display:${hasPermission("operator")?"":"none"}" onclick="deleteWorkOrder(${wo.id})">'
)
# Simpler approach: just use inline style
content = content.replace(
    '<button class="btn btn-sm btn-danger" onclick="deleteWorkOrder(${wo.id})">🗑️ 删除</button>',
    '<button class="btn btn-sm btn-danger" onclick="deleteWorkOrder(${wo.id})" style="display:${hasPermission("operator")?"":"none"}">🗑️ 删除</button>'
)
content = content.replace(
    '<button class="btn btn-sm" onclick="addNoteFromDetail(${wo.id})">添加</button>',
    '<button class="btn btn-sm" onclick="addNoteFromDetail(${wo.id})" style="display:${hasPermission("operator")?"":"none"}">添加</button>'
)
content = content.replace(
    '${allowedTransitions.map(s => `<button class="btn btn-sm btn-outline" onclick="changeStatusFromDetail(${wo.id}, \'${s}\')">${WO_STATUS_NAMES[s]}</button>`).join(\'\')}',
    '<div style="display:${hasPermission("operator")?"":"none"}">${allowedTransitions.map(s => `<button class="btn btn-sm btn-outline" onclick="changeStatusFromDetail(${wo.id}, \'${s}\')">${WO_STATUS_NAMES[s]}</button>`).join(\'\')}</div><span style="display:${hasPermission("operator")?"none":""};color:var(--text-muted);font-size:0.75rem;">无操作权限</span>'
)

content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
      if (!hasPermission("operator")) hideElement("btn-create-wo");
    }
    applyRoleControls();
''')
with open('workorder.html', 'w') as f:
    f.write(content)
print("workorder.html done")

# ====== inspection.html ======
with open('inspection.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html"', '<a class="nav-tab" id="nav-users" href="users.html"')
content = content.replace('<a class="nav-tab" href="audit.html"', '<a class="nav-tab" id="nav-audit" href="audit.html"')
content = content.replace('onclick="showCreateInspection()">', 'id="btn-create-inspection" onclick="showCreateInspection()">')
content = content.replace('onclick="generateForecast()">', 'id="btn-forecast" onclick="generateForecast()">')
content = content.replace('onclick="processDueInspections()">', 'id="btn-process-due" onclick="processDueInspections()">')

content = content.replace(
    '<button class="btn btn-sm btn-red" onclick="deleteInspection(${insp.id})">删除</button>',
    '<button class="btn btn-sm btn-red" onclick="deleteInspection(${insp.id})" style="display:${hasPermission("operator")?"":"none"}">删除</button>'
)
content = content.replace(
    '<button class="btn btn-sm" onclick="viewInspectionTasks(${insp.id})">查看任务</button>',
    '${hasPermission("operator") ? \'<button class="btn btn-sm" onclick="editInspection(${insp.id})">编辑</button>\' : \'\'}<button class="btn btn-sm" onclick="viewInspectionTasks(${insp.id})">查看任务</button>'
)

content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
      if (!hasPermission("operator")) {
        hideElement("btn-create-inspection");
        hideElement("btn-forecast");
        hideElement("btn-process-due");
      }
    }
    applyRoleControls();
''')
with open('inspection.html', 'w') as f:
    f.write(content)
print("inspection.html done")

# ====== analysis.html ======
with open('analysis.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html"', '<a class="nav-tab" id="nav-users" href="users.html"')
content = content.replace('<a class="nav-tab" href="audit.html"', '<a class="nav-tab" id="nav-audit" href="audit.html"')
content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
      if (!hasPermission("operator")) hideElement("uploadArea");
    }
    applyRoleControls();
''')
with open('analysis.html', 'w') as f:
    f.write(content)
print("analysis.html done")

# ====== daily-report.html ======
with open('daily-report.html', 'r') as f:
    content = f.read()
content = content.replace('<a href="audit.html">', '<a href="audit.html" id="nav-audit">')
content = content.replace('<a href="users.html">', '<a href="users.html" id="nav-users">')
content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
    }
    applyRoleControls();
''')
with open('daily-report.html', 'w') as f:
    f.write(content)
print("daily-report.html done")

# ====== notification.html ======
with open('notification.html', 'r') as f:
    content = f.read()
content = content.replace('<a class="nav-tab" href="users.html"', '<a class="nav-tab" id="nav-users" href="users.html"')
content = content.replace('<a class="nav-tab" href="audit.html"', '<a class="nav-tab" id="nav-audit" href="audit.html"')
content = add_role_code(content, '''
    function applyRoleControls() {
      if (!hasPermission("admin")) hideElement("nav-users");
      if (!hasPermission("manager")) hideElement("nav-audit");
    }
    applyRoleControls();
''')
with open('notification.html', 'w') as f:
    f.write(content)
print("notification.html done")

print("\n=== All files updated ===")
