import os
import json

def clean(dir_path):
    if not os.path.isdir(dir_path):
        print(f"错误: 目录不存在 -> {dir_path}")
        return
    for root, dirs, files in os.walk(dir_path):
        for file in files:
            if file.endswith('.json'):
                path = os.path.join(root, file)
                print(f"Processing {file}...")
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                # 删除不必要的字段
                for item in data.get("results", []):
                    for key in ["moderator_remark", "modified_at", "semester", "reactions", "is_mine"]:
                        if key in item:
                            del item[key]
                # 将清洗后的数据写回文件
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    # 使用脚本所在目录作为基准路径
    script_dir = os.path.dirname(os.path.abspath(__file__))
    target_dir = os.path.join(script_dir, 'courses')
    clean(target_dir)