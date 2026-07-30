'''
建立教务系统课程号与选课社区课程id之间的映射关系
'''

import json
import normalize

LEARN_DATA_PATH = "./main/data/learn/courses_2026-2027-1.json"
FULL_INDEX_PATH = "./main/data/full_index.json"

# 储存对应关系
kch_to_sqid = {}
sqid_to_kch = {}

warnings = []  # 用于存储警告信息

with open(LEARN_DATA_PATH, 'r', encoding='utf-8') as f:
    learn_data = json.load(f)["object"]["aaData"]

with open(FULL_INDEX_PATH, 'r', encoding='utf-8') as f:
    full_index = json.load(f)["courses"]

def main():
    for item in learn_data:
        # 读取信息并规范化
        kch = item['kch']
        kcm = normalize.kcm(item['kcm'])
        jsm = normalize.jsm(item['jsmc'])
        full_name = f"{kcm}({jsm})"
        sqid = full_index.get(full_name, {}).get("sqid") # 获取当前课程号对应的sqid
        if sqid is not None:
        # 可以找到对应sqid
            if kch not in kch_to_sqid:
            # 未收录时进行收录
                kch_to_sqid[kch] = [sqid]
            elif sqid not in kch_to_sqid[kch]:
            # 已收录时进行追加
                kch_to_sqid[kch].append(sqid)

            if sqid not in sqid_to_kch:
            # 未收录时进行收录
                sqid_to_kch[sqid] = [kch]
            else:
            # 已收录时追加
                sqid_to_kch[sqid].append(kch) if kch not in sqid_to_kch[sqid] else None
        else:
        # 找不到对应sqid时警告
            warnings.append(f"Warning: full_name {full_name} not found in full_index\n")

    # 写入文件
    with open("./main/data/kch_to_sqid.json", 'w', encoding='utf-8') as f:
        json.dump(kch_to_sqid, f, ensure_ascii=False, indent=4)

    with open("./main/data/sqid_to_kch.json", 'w', encoding='utf-8') as f:
        json.dump(sqid_to_kch, f, ensure_ascii=False, indent=4)

    # 写入警告信息
    with open("./main/data/process_data/warnings.json", 'w', encoding='utf-8') as f:
        json.dump(warnings, f, ensure_ascii=False, indent=4)

if __name__ == "__main__":
    main()